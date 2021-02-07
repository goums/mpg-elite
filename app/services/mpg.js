"use strict";

const debug = require("debug")("mpg:api");
const https = require("https");

const mpgToken = process.env.MPG_TOKEN;
const mpgLeagueCode = process.env.MPG_LEAGUE;

const _callApi = (endpoint, params) => {
  const options = {
    hostname: "api.monpetitgazon.com",
    path: `/league/${mpgLeagueCode}/${endpoint}`,
    headers: {
      Authorization: mpgToken,
      platform: "web",
      "client-version": "6.9.1"
    }
  };
  debug("Calling api:", options.path);
  return new Promise((resolve, reject) => {
    https
      .get(options, (res) => {
        res.setEncoding("utf8");
        const body = [];
        res.on("data", (chunk) => body.push(chunk));
        res.on("end", () => {
          resolve(JSON.parse(body.join("")));
        });
      })
      .on("error", reject);
  });
};

const _createTeamRank = (team, rank) => {
  return {
    userId: team.userId,
    name: team.name,
    target: rank.targetMan,
    symbol: team.abbr,
    icon: team.jerseyUrl,
    points: rank.points,
    played: rank.played,
    wins: rank.victory,
    loses: rank.defeat,
    draws: rank.draw,
    goalFor: rank.goal,
    goalAgainst: rank.goalconceded,
    difference: rank.difference,
    series: rank.series.split("")
  };
};

const _insertSorted = (array, row) => {
  let index = 0;
  while (
    index < array.length &&
    (array[index].points > row.points ||
      (array[index].points === row.points && array[index].difference > row.difference))
  ) {
    index++;
  }
  array.splice(index, 0, row);
};

module.exports.getFirstPhaseRanking = async () => {
  const data = await _callApi("ranking/winners");
  return data.winners.shift().ranking.map((rank) => _createTeamRank(data.teams[rank.teamid], rank));
};

module.exports.getSecondPhaseRanking = async () => {
  const data = await _callApi("ranking");
  return data.ranking.map((rank) => _createTeamRank(data.teams[rank.teamid], rank));
};

module.exports.getCumulateRanking = (firstRanking, secondRanking) => {
  const cumulateRanking = [];
  secondRanking.forEach((rank) => {
    const rankToAdd = firstRanking.find((r) => r.userId === rank.userId);
    _insertSorted(cumulateRanking, {
      ...rank,
      points: rank.points + rankToAdd.points,
      played: rank.played + rankToAdd.played,
      wins: rank.wins + rankToAdd.wins,
      loses: rank.loses + rankToAdd.loses,
      draws: rank.draws + rankToAdd.draws,
      goalFor: rank.goalFor + rankToAdd.goalFor,
      goalAgainst: rank.goalAgainst + rankToAdd.goalAgainst,
      difference: rank.difference + rankToAdd.difference,
      series: rankToAdd.series.concat(rank.series).slice(-5)
    });
  });
  return cumulateRanking;
};

module.exports.getCalendar = async (day = null) => {
  const data = await _callApi(`calendar/${day ?? ""}`);
  return data.data.results;
};
