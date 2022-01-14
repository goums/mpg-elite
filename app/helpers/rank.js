"use strict";

const rankColor = [
  "rgb(69, 201, 69)",
  "rgba(69, 201, 69, 0.75)",
  "rgba(69, 201, 69, 0.5)",
  "rgba(0, 0, 0, 0)",
  "rgba(0, 0, 0, 0)",
  "rgba(0, 0, 0, 0)",
  "rgba(214, 30, 0, 0.5)",
  "rgb(214, 30, 0, 0.75)"
];

const seriesClasses = {
  w: "index__v___30agd",
  l: "index__d___1IAAG",
  d: "index__n___2H3lP"
};

module.exports.indexToRank = (index) => index + 1;
module.exports.indexToRankColor = (index) => rankColor[index];
module.exports.serieClassname = (serie) => seriesClasses[serie];
