"use strict";

const express = require("express");
const router = express.Router();
const mpg = require("../services/mpg");
const debug = require("debug")("mpg:calendar");

//Render Ranking view
router.get("/:day?", async (req, res) => {
  const { currentMatchDay, maxMatchDay, date, live, matches } = await mpg.getCalendar(req.params.day);
  //debug({ currentMatchDay, maxMatchDay, date, live, matches });
  const prevMatchDay = currentMatchDay > 1 ? currentMatchDay - 1 : false;
  const nextMatchDay = currentMatchDay < maxMatchDay ? currentMatchDay + 1 : false;
  const days = [];
  for (let i = 1; i <= maxMatchDay; i++) {
    days.push(i);
  }
  res.render("calendar", {
    menu: "calendar",
    days,
    prevMatchDay,
    currentMatchDay,
    nextMatchDay,
    date,
    live,
    matches
  });
});

module.exports = router;
