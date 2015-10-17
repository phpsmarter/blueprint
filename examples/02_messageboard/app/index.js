#!/usr/bin/env node

var winston   = require ('winston')
  , xpression = require ('xpression')
  ;

var app = new xpression.Application (__dirname);
app.start (function (err) {
  if (err)
    return winston.log ('error', err);

  winston.log ('info', 'application started...');
});
