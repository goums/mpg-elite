"use strict";

const express = require("express");
const router = express.Router();
const mpg = require("../services/mpg");
const debug = require("debug")("mpg:match");

//Render Ranking view
router.get("/:matchId", async (req, res) => {
  const match = await mpg.getMatch(req.params.matchId);
  res.render("match", {
    menu: "calendar",
    ...match
  });
});

module.exports = router;
