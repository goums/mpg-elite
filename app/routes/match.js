"use strict";

const express = require("express");
const router = express.Router();
const mpg = require("../services/mpg");
const debug = require("debug")("mpg:match");

//Render Ranking view
router.get("/:live?/:matchId", async (req, res) => {
  const match = await mpg.getMatch(req.params.matchId, req.params.live);
  const matchDay = req.params.matchId.split("_")[1];
  res.render("match", {
    menu: "calendar",
    matchDay,
    ...match
  });
});

module.exports = router;
