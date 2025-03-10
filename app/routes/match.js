"use strict";

const express = require("express");
const router = express.Router();
const mpg = require("../services/mpg");
const debug = require("debug")("mpg:match");

//Render Ranking view
router.get("/:matchId", async (req, res) => {
  try {
    const match = await mpg.getMatch(req.params.matchId);
    res.render("match", {
      menu: "calendar",
      ...match
    });
  } catch (error) {
    debug("Error fetching match:", error);
    res.render("error", {
      message: `Error fetching match: ${error.message}`
    });
  }
});

module.exports = router;
