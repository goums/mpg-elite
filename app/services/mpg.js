"use strict";

const debug = require("debug")("mpg:api");
const https = require("https");

const mpgToken = process.env.MPG_TOKEN;
const mpgLeagueCode = process.env.MPG_LEAGUE;

const _leagueEndpoint = (endpoint) => `/league/${mpgLeagueCode}${endpoint}`;

const _callApi = (endpoint) => {
  const options = {
    hostname: "api.monpetitgazon.com",
    path: endpoint,
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
  const data = await _callApi(_leagueEndpoint("/ranking/winners"));
  return data.winners.shift().ranking.map((rank) => _createTeamRank(data.teams[rank.teamid], rank));
};

module.exports.getSecondPhaseRanking = async () => {
  const data = await _callApi(_leagueEndpoint("/ranking"));
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
  const data = await _callApi(_leagueEndpoint(`/calendar/${day ?? ""}`));
  return data.data.results;
};

const _addPlayer = (isLive, player, teamPlayers, teamSubstitutes, teamGoals, adversaryGoals) => {
  if (!player.playerId && !player.id) return;

  if (parseInt(player.number) <= 11) {
    if (player.substitute) {
      //replace player by its substitute for this position
      player.substitute.number = player.number;
      teamPlayers.push(player.substitute);
    } else {
      teamPlayers.push(player);
    }
  } else {
    teamSubstitutes.push(player);
    //ignore goals from substitue for live match
    if (isLive) return;
  }

  //look for substituted player in case of non-live match
  if (!isLive && player.substitute) player = player.substitute;

  if (player.goals?.goal > 0) {
    teamGoals.push({ type: "goal", p: player });
  }
  if (player.goals?.mpg > 0) {
    teamGoals.push({ type: "mpg", p: player });
  }
  if (player.goals?.own_goal > 0) {
    adversaryGoals.push({ type: "own", p: player });
  }
};

module.exports.getMatch = async (matchId, isLive) => {
  let data;
  if (isLive) {
    data = await _callApi(`/live/match/mpg_match_${mpgLeagueCode}_${matchId}`);
  } else {
    data = await _callApi(_leagueEndpoint(`/results/${matchId}`));
    data = data.data;
  }

  data.teamHome.goals = [];
  data.teamHome.players = [];
  data.teamHome.substitutePlayers = [];
  data.teamAway.goals = [];
  data.teamAway.players = [];
  data.teamAway.substitutePlayers = [];
  data.players.home.forEach((player) => {
    _addPlayer(
      isLive,
      player,
      data.teamHome.players,
      data.teamHome.substitutePlayers,
      data.teamHome.goals,
      data.teamAway.goals
    );
  });
  data.players.away.forEach((player) => {
    _addPlayer(
      isLive,
      player,
      data.teamAway.players,
      data.teamAway.substitutePlayers,
      data.teamAway.goals,
      data.teamHome.goals
    );
  });

  return data;
};
