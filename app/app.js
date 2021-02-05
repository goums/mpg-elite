"use strict";

const express = require("express");
const path = require("path");
const logger = require("morgan");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const compression = require("compression");
const favicon = require("serve-favicon");
const debug = require("debug")("mpg:app");
const exphbs = require("express-handlebars");
const rankHelper = require("./helpers/rank");
const rankingRouter = require("./routes/ranking");
const app = express();

//Setup favicon
app.use(favicon(path.join(__dirname, "..", "public", "favicon.svg")));

//Set pretty print json space
app.set("json spaces", 2);

//Include standard middlewares
app.use(compression());
app.use(logger("dev"));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "..", "public"), { "Cache-Control": false }));

//Set view engine
app.set("views", path.join(__dirname, "views"));
app.engine(
  ".hbs",
  exphbs({
    extname: ".hbs",
    helpers: {
      ...rankHelper
    }
  })
);
app.set("view engine", ".hbs");

//Let app know we are behind a proxy to retreive IP via X-Forwarded-For header
app.enable("trust proxy");

//Mount routers
app.use("/", rankingRouter);

//Catch 404 and forward to error handler
app.use((req, res, next) => {
  const err = new Error("Not Found");
  err.status = 404;
  next(err);
});

//Error handlers
app.use((err, req, res, next) => {
  if (!res.headersSent) {
    res.status(err.status || 500);
    res.send(err.status ? err.message : "Technical Error");
  }
  //Debug only non 404 and 401 errors
  if (!err.status || (err.status !== 404 && err.status !== 401 && err.status !== 400)) {
    debug(err);
  }
});

module.exports = app;
