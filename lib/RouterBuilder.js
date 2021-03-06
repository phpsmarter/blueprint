const express  = require ('express')
  , winston    = require ('winston')
  , util       = require ('util')
  , async      = require ('async')
  , objectPath = require ('object-path')
  , _          = require ('underscore')
  ;

const errors   = require ('./errors/')
  ;

const SINGLE_ACTION_CONTROLLER_METHOD = '__invoke';
const SINGLE_RESOURCE_BASE_PATH = '/:rcId';

/**
 * Factory method that generates an action object.
 *
 * @param controller
 * @param method
 * @param options
 * @returns {{action: string, options: *}}
 */
function makeAction (controller, method, options) {
  var action = {action: controller + '@' + method};

  if (options)
    action.options = options;

  return action;
}

/**
 * Default function for handling an error returned via a VaSE callback.
 *
 * @param err
 * @param res
 * @param next
 * @returns {*}
 */
function handleError (err, res) {
  var errType = typeof err;

  if (errType === 'string') {
    res.status (400).type ('text/plain').send (err);
  }
  else if (errType === 'object') {
    res.type ('application/json');

    if (err instanceof errors.Error) {
      // We are working with an instance of a Blueprint error. This means that we have
      // can sent an error object to the client. If the error is a HttpError, then
      // the error object contains the status code as well.
      err.accept ({
        visitHttpError: function (e) { res.status (e.statusCode); },
        visitBlueprintError: function () { res.status (500); }
      });

      var data = {
        errors: {
          code: err.code,
          message: err.message
        }
      };

      if (err.details)
        data.errors.details = err.details;

      res.send (data);
    }
    else if (err instanceof Error) {
      // If this is a plan error object from JavaScript, then the only attribute
      // guaranteed is the message attribute.
      res.status (500).send ({
        errors: {
          message: err.message
        }
      });
    }
    else {
      // This is just a regular object. We are going to set the details
      // attribute on the returned error object.

      res.status (500).send ({
        errors: {
          details: err
        }
      });
    }
  }
}

function validateBySchema (schema) {
  return function __blueprint_validate_schema (req, res, next) {
    try {
      req.check (schema);

      // Validate the request using the provided schema.
      var errors = req.validationErrors ();
      if (!errors) return next ();

      var err = new errors.HttpError (400, 'validation_failed', 'Request validation failed', errors);
      return handleError (err, res);
    }
    catch (ex) {
      handleError (ex, res);
    }
  }
}

function validateByFunction (validator) {
  return function __blueprint_validate_function (req, res, next) {
    try {
      return validator (req, function (err) {
        if (!err) return next ();
        return handleError (err, res);
      });
    }
    catch (ex) {
      return handleError (ex, res);
    }
  }
}

function executor (execute) {
  return function __blueprint_execute (req, res, next) {
    try {
      return execute (req, res, function (err) {
        if (!err) return next ();
        return handleError (err, res);
      });
    }
    catch (ex) {
      return handleError (ex, res);
    }
  }
}

function sanitizer (sanitize) {
  return function __blueprint_sanitize (req, res, next) {
    try {
      return sanitize (req, function (err) {
        if (!err) return next ();
        return handleError (err, res);
      });
    }
    catch (ex) {
      return handleError (ex, res);
    }
  }
}

function render (view) {
  return function __blueprint_render (req, res) {
    res.render (view);
  };
}

/**
 * @class MethodCall
 *
 * Helper class for using reflection to call a method.
 *
 * @param obj
 * @param method
 * @constructor
 */
function MethodCall (obj, method) {
  this._obj = obj;
  this._method = method;

  this.invoke = function () {
    return this._method.apply (this._obj, arguments);
  };
}

// The solution for endWith() is adopted from the following solution on
// StackOverflow:
//
//  http://stackoverflow.com/a/2548133/2245732

if (!_.isFunction (String.prototype.endsWith)) {
  String.prototype.endsWith = function (suffix) {
    return this.indexOf (suffix, this.length - suffix.length) !== -1;
  };
}

/**
 * @class RouterBuilder
 *
 * Builder class for building an express.Router object.
 *
 * @param controllers       Collection of controllers for binding
 * @param basePath          Base path of the router
 * @constructor
 */
function RouterBuilder (controllers, basePath) {
  this._controllers = controllers;
  this._basePath = basePath || '/';
  this._router = express.Router ();
  this._params = [];

  /**
   * Resolve the controller of an action.
   *
   * @param action
   * @returns {MethodCall}
   */
  this.resolveController = function (action) {
    var parts = action.split ('@');

    if (parts.length < 1 || parts.length > 2)
      throw new Error (util.format ('invalid action format [%s]', action));

    var controllerName = parts[0];
    var actionName = parts.length === 2 ? parts[1] : SINGLE_ACTION_CONTROLLER_METHOD;

    // Locate the controller object in our loaded controllers. If the controller
    // does not exist, then throw an exception.
    var controller = objectPath.get (this._controllers, controllerName);

    if (!controller)
      throw new Error (util.format ('controller %s not found', controllerName));

    // Locate the action method on the loaded controller. If the method does
    // not exist, then throw an exception.
    var method = controller[actionName];

    if (!method)
      throw new Error (util.format ('controller %s does not define method %s', controllerName, actionName));

    return new MethodCall (controller, method);
  }
}

/**
 * Add routes defined by a specification.
 *
 * @param spec
 * @param currPath
 *
 * @returns {RouterBuilder}
 */
RouterBuilder.prototype.addSpecification = function (spec, currPath) {
  var self = this;

  /**
   * Register a route with the router. A router starts with a forward slash (/).
   *
   * @param verb            Http verb to process
   * @param currPath        Current path for the specification
   * @param opts            Options for the path
   */
  function processVerb (verb, currPath, opts) {
    if (verb === 'resource')
      defineResource (currPath, opts);
    else
      defineVerbHandler (verb, currPath, opts);

    /**
     * Process a resource path. The controller in this path must be an instance
     * of a ResourceController.
     */
    function defineResource (path, opts) {
      // Define the resource specification.

      winston.log ('debug', 'processing resource %s', path);

      // Locate the controller specified in the options.
      var controllerName = opts.controller;

      if (!controllerName)
        throw new Error (util.format ('%s is missing controller property', path));

      var controller = objectPath.get (self._controllers, controllerName);

      if (!controller)
        throw new Error (util.format ('%s controller does not exist', controllerName));

      // Get the actions of the controller.
      var actions = controller.actions;

      if (!actions)
        throw new Error (util.format ('%s must define actions property', controllerName));

      var resourceId = controller['resourceId'];

      if (!resourceId)
        throw new Error (util.format ('%s must define resourceId property', controllerName));

      if (opts.allow && opts.deny)
        throw new Error (util.format ('%s can only define allow or deny property, not both', path));

      // All actions in the resource controller are allowed from the beginning. We
      // adjust this collection based on the actions defined by the allow/deny property.

      var allowed = Object.keys (actions);

      if (opts.allow)
        allowed = opts.allow;

      if (opts.deny) {
        // Remove the actions that are being denied.
        for (var i = 0, len = opts.deny.length; i < len; ++ i)
          allowed.splice (allowed.indexOf (opts.deny[i]), 1);
      }

      // Build the specification for managing the resource.
      var singleBasePath = '/:' + resourceId;
      var spec = {};
      var singleSpec = {};

      allowed.forEach (function (name) {
        var action = actions[name];

        if (_.isArray (action)) {
          action.forEach (function (item) {
            processAction (item);
          });
        }
        else if (_.isObject (action)) {
          processAction (action);
        }

        function processAction (action) {
          if (action.path) {
            if (action.path.startsWith (SINGLE_RESOURCE_BASE_PATH)) {
              var part = action.path.slice (SINGLE_RESOURCE_BASE_PATH.length);

              if (part.length === 0) {
                // We are working with an action for a single resource.
                singleSpec[action.verb] = makeAction (controllerName, action.method, opts.options);
              }
              else {
                if (!singleSpec[part])
                  singleSpec[part] = {};

                singleSpec[part][action.verb] = makeAction (controllerName, action.method, opts.options);
              }
            }
            else {
              // We are working with an action for the collective resources.
              spec[action.path] = {};
              spec[action.path][action.verb] = makeAction (controllerName, action.method, opts.options);
            }
          }
          else {
            // We are working with an action for the collective resources.
            spec[action.verb] = makeAction (controllerName, action.method, opts.options);
          }
        }
      });

      // Add the specification for managing a since resource to the specification
      // for managing all the resources.
      spec[singleBasePath] = singleSpec;

      self.addSpecification (spec, path)
    }

    /**
     * Define a handler for a single HTTP verb, such as get, put, and delete. The
     * value of \a verb can be any HTTP verb support by Express.js.
     *
     * @param     verb        HTTP verb
     * @param     path        Path associated with verb
     * @param     opts        Definition options
     */
    function defineVerbHandler (verb, path, opts) {
      var verbFunc = self._router[verb.toLowerCase ()];

      if (!verbFunc)
        throw new Error (util.format ('%s is not a valid http verb', verb));

      winston.log ('debug', 'processing %s %s', verb.toUpperCase (), currPath);

      // Make sure there is either an action or view defined.
      if (opts.action === undefined && opts.view === undefined)
        throw new Error (util.format ('%s %s must define an action or view property', verb, currPath));

      var middleware = opts.before || [];

      if (opts.action) {
        // Resolve controller and its method. The expected format is controller@method. We are
        // also going to pass params to the controller method.
        var controller = self.resolveController (opts.action);
        var params = {path: path};

        if (opts.options)
          params.options = opts.options;

        var result = controller.invoke (params);

        if (_.isFunction (result) || _.isArray (result)) {
          // Push the function/array onto the middleware stack.
          middleware.push (result);
        }
        else if (_.isObject (result)) {
          // The user elects to have separate validation, sanitize, and execution
          // section for the controller method. There must be a execution function.
          if (!result.execute)
            throw new Error (util.format ('Controller method must define an \'execute\' property [%s %s]', verb, currPath));

          // The controller method has the option of validating and sanitizing the
          // input data. We need to check for either one and add middleware functions
          // if it exists.
          if (result.validate) {
            var validate = result.validate;

            if (_.isFunction (validate)) {
              // The method has its own validation function.
              middleware.push (validateByFunction (validate));
            }
            else if (_.isObject (validate) && !_.isArray (validate)) {
              // The method is using a express-validator schema for validation.
              middleware.push (validateBySchema (validate));
            }
            else {
              throw new Error (util.format ('Unsupported validate value [%s]', util.inspect (validate)));
            }
          }

          if (result.sanitize)
            middleware.push (sanitizer (result.sanitize));

          // Lastly, push the execution function onto the middleware stack.
          middleware.push (executor (result.execute));
        }
        else {
          throw new Error ('Return type of controller method must be a function or object');
        }
      }
      else if (opts.view) {
        // Use a generic callback to render the view. Make sure we save a reference
        // to the target view since the opts variable will change during the next
        // iteration.
        middleware.push (render (opts.view));
      }

      // Add all middleware that should happen after processing.
      if (opts.after)
        middleware = middleware.concat (opts.after);

      // Define the route path. Let's be safe and make sure there is no
      // empty middleware being added to the route.
      if (middleware.length > 0)
        verbFunc.call (self._router, path, middleware);
    }
  }

  /**
   * Process the <use> statement in the router. If the path is defined, then the
   * handlers are bound to the path. If there is no path, then the handlers are
   * used for all paths.
   *
   * @param path
   * @param handlers
   */
  function processUse (path, handlers) {
    winston.log ('debug', 'processing use %s', path);
    self._router.use (path, handlers);
  }

  if (!currPath)
    currPath = this._basePath;

  if (_.isArray (spec) || _.isFunction (spec)) {
    // The specification is either an array of middleware, or a previously defined
    // router imported into this specification. An example of the latter case is
    // someone importing a router from an existing blueprint module.
    this._router.use (currPath, spec);
  }
  else if (_.isObject (spec)) {
    // First, we start with the head verb since it must be defined before the get
    // verb. Otherwise, express will use the get verb over the head verb.
    if (spec.head)
      processVerb ('head', currPath, spec.head);

    // The specification is a text-based key-value pair. We need to read each key
    // in the specification and build the described router.
    for (var key in spec) {
      if (!spec.hasOwnProperty (key) || key === 'head')
        continue;

      if (key === 'use') {
        // This is a use specification, but without a path because it is associated
        // with the router. So, process the use specification without specifying a path.
        processUse (currPath, spec[key]);
      }
      else {
        // The first letter of the key is a hint at how to process this key's value.
        switch (key[0]) {
          case '/':
            var innerPath = currPath + (currPath.endsWith ('/') ? key.slice (1) : key);
            this.addSpecification (spec[key], innerPath);
            break;

          case ':':
            this.addParameter (key, spec[key]);
            break;

          default:
            processVerb (key, currPath, spec[key]);
        }
      }
    }
  }
  else {
    throw Error ('Specification must be a object, router function, or an array of router functions');
  }

  return this;
};

RouterBuilder.prototype.addParameter = function (param, opts, override) {
  winston.log ('debug', 'processing parameter %s', param);

  // We only add a parameter once unless we are overriding the existing
  // parameter definition.
  if (this._params.indexOf (param) !== -1 && !override)
    return;

  var rawParam = param.slice (1);
  var handler;

  if (_.isFunction (opts)) {
    handler = opts;
  }
  else if (_.isObject (opts)) {
    if (opts.action) {
      // The parameter invokes an operation on the controller.
      var controller = this.resolveController (opts.action);
      handler = controller.invoke ();
    }
    else {
      throw new Error ('Invalid parameter specification (' + param + ')');
    }
  }
  else {
    throw new Error (util.format ('opts must be a Function or Object [param=%s]', param));
  }

  if (handler != null)
    this._router.param (rawParam, handler);

  // Cache the parameter so we do not add it more than once.
  if (this._params.indexOf (param) === -1)
    this._params.push (param);
};

/**
 * Get the router.
 *
 * @returns {*}
 */
RouterBuilder.prototype.getRouter = function () {
  return this._router;
};

RouterBuilder.prototype.addRouters = function (routers) {
  for (var key in routers) {
    if (routers.hasOwnProperty (key)) {
      var value = routers[key];
      
      if (_.isFunction (value) || _.isArray (value))
        this._router.use (value);
      else
        this.addRouters (value);
    }
  }

  return this;
};

module.exports = exports = RouterBuilder;