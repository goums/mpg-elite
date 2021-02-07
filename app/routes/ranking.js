"use strict";

const express = require("express");
const router = express.Router();
const mpg = require("../services/mpg");
const debug = require("debug")("mpg:ranking");

//Render Ranking view
router.get("/", async (req, res) => {
  const rankingFirstPhase = await mpg.getFirstPhaseRanking();
  const rankingSecondPhase = await mpg.getSecondPhaseRanking();
  const rankingCumulate = mpg.getCumulateRanking(rankingFirstPhase, rankingSecondPhase);

  res.render("ranking", {
    menu: "ranking",
    rankingFirstPhase,
    rankingSecondPhase,
    rankingCumulate
  });
});

module.exports = router;
