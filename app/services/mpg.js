"use strict";

const debug = require("debug")("mpg:api");
const https = require("https");
const { isNumber } = require("util");

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
  const { data } = await _callApi(_leagueEndpoint(`/calendar/${day ?? ""}`));

  //retrieve full match details
  if (data.results.live || data.results.date < new Date().getTime()) {
    data.results.matches = await Promise.all(
      data.results.matches.map(async (match) => getMatch(match.id, data.results.live))
    );
  }

  return data.results;
};

const _addPlayer = (player, defBonus, teamPlayers, teamSubstitutes) => {
  if (!player.playerId && !player.id) return;

  //add defBonus for starting player
  if (player.position === 2 && defBonus && parseInt(player.number) <= 11) player.bonus = defBonus;

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
  }
};

const _addPlayerGoals = (player, teamGoals, adversaryGoals) => {
  if (!player.playerId && !player.id) return;
  if (parseInt(player.number) > 11) return;

  //look for substituted player
  if (player.virtualSubstitute) {
    addGoals(player, teamGoals, adversaryGoals, "out");
    addGoals(player.virtualSubstitute, teamGoals, adversaryGoals, "in");
  } else {
    addGoals(player, teamGoals, adversaryGoals, "start");
  }
};

const addGoals = (player, teamGoals, adversaryGoals, compo) => {
  if (player.goals?.goal > 0) {
    teamGoals.push({ type: "goal", p: player, compo });
  }
  if (player.goals?.mpg > 0) {
    teamGoals.push({ type: "mpg", p: player, compo });
  }
  if (player.goals?.own_goal > 0) {
    adversaryGoals.push({ type: "own", p: player, compo });
  }
};

const defBonus = (composition) => {
  if (composition > 500) return 1;
  if (composition > 400) return 0.5;
  return 0;
};

const calculateVirtualPlayers = (players, substitutes, defBonus) => {
  substitutes.forEach((s) => {
    s.subPlayer = players.find((p) => p.playerId === s.subs);
  });
  let availableSubstitutes = players.filter((p) => parseInt(p.number) > 11 && p.position > 1);

  players.forEach((p) => {
    //set default rating and bonus if missing
    const isRotaldo = p.starter === -1 || (p.starter === 2 && !p.rating);
    if (isRotaldo) console.log(`ROTALDO => ${p.name}`);
    p.virtualRating = isRotaldo ? 2.5 : p.rating ?? 5;
    p.virtualBonus = p.bonus ?? (!isRotaldo && p.position === 2 && defBonus && parseInt(p.number) <= 11 ? defBonus : 0);

    //check tactical substitute
    const subTact = substitutes.find((s) => s.start === p.playerId);
    //console.log(subTact);
    if (subTact && p.virtualRating + p.virtualBonus < subTact.rating) {
      if (subTact.subPlayer && subTact.subPlayer.rating) {
        p.virtualSubstitute = subTact.subPlayer;
        //remove substitute from available ones
        availableSubstitutes = availableSubstitutes.filter((s) => s.playerId !== subTact.subs);
      }
    }

    //check keeper auto substitute
    if (isRotaldo && p.position === 1 && parseInt(p.number) <= 11) {
      const sub = players.find((s) => s.position === 1 && s.playerId !== p.playerId);
      if (sub && sub.rating) {
        console.log(`GOAL SUBSTITUE: ${sub.name} replace ${p.name}`);
        p.virtualSubstitute = sub;
      }
    }
  });

  //check default substitute
  console.log("original substitutes:", substitutes.map((s) => s.substituteName).join(","));
  console.log("available substitutes:", availableSubstitutes.map((s) => s.name).join(","));

  const notPlayed = players.filter(
    (p) => (p.starter === -1 || (p.starter === 2 && !p.rating)) && parseInt(p.number) <= 11 && !p.virtualSubstitute
  );
  console.log("rotaldo??", notPlayed.map((s) => s.name).join(","));
  if (notPlayed.length > 0) {
  }
  notPlayed.forEach((p) => {
    let subFound = false;
    let checkingPos = p.position;
    do {
      let i = 0;
      while (!subFound && i < availableSubstitutes.length) {
        const subPlayer = availableSubstitutes[i];
        if (subPlayer.rating && subPlayer.position === checkingPos) {
          subPlayer.rating = subPlayer.rating - (p.position - subPlayer.position);
          console.log(`Substitution: ${subPlayer.name} replace ${p.name} with rating ${subPlayer.rating}`);
          p.virtualSubstitute = subPlayer;
          //remove substitute from available ones
          availableSubstitutes = availableSubstitutes.filter((s) => s.playerId !== subPlayer.playerId);
          subFound = true;
        }
        i++;
      }
      checkingPos--;
    } while (!subFound && checkingPos >= 1);
  });
};

const calculateMpgGoals = (homePlayers, awayPlayers) => {
  //calculate line average score
  const homeScores = {
    keeper: calculateLineScore(homePlayers.filter((p) => p.position === 1 && parseInt(p.number) <= 11)),
    def: calculateLineScore(homePlayers.filter((p) => p.position === 2 && parseInt(p.number) <= 11)),
    middle: calculateLineScore(homePlayers.filter((p) => p.position === 3 && parseInt(p.number) <= 11)),
    forward: calculateLineScore(homePlayers.filter((p) => p.position === 4 && parseInt(p.number) <= 11))
  };
  console.log("homeScores", homeScores);

  const awayScores = {
    keeper: calculateLineScore(awayPlayers.filter((p) => p.position === 1 && parseInt(p.number) <= 11)),
    def: calculateLineScore(awayPlayers.filter((p) => p.position === 2 && parseInt(p.number) <= 11)),
    middle: calculateLineScore(awayPlayers.filter((p) => p.position === 3 && parseInt(p.number) <= 11)),
    forward: calculateLineScore(awayPlayers.filter((p) => p.position === 4 && parseInt(p.number) <= 11))
  };

  console.log("awayScores", awayScores);

  //calculate MPG goals...
  homePlayers
    .filter((p) => p.position > 1 && parseInt(p.number) <= 11 && p.goals?.goal === 0)
    .forEach((p) => {
      calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus + 0.01, awayScores);
      if (p.virtualSubstitute && p.virtualSubstitute.goals?.goal === 0) {
        p = p.virtualSubstitute;
        calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus + 0.01, awayScores);
      }
    });

  awayPlayers
    .filter((p) => p.position > 1 && parseInt(p.number) <= 11 && p.goals?.goal === 0)
    .forEach((p) => {
      calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus, homeScores);
      if (p.virtualSubstitute && p.virtualSubstitute.goals?.goal === 0) {
        p = p.virtualSubstitute;
        calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus, homeScores);
      }
    });
};

const calculatePlayerMpgGoal = (p, score, adversaryScores) => {
  let pos = p.position;
  let steps = 0;

  if (pos === 2 && score > adversaryScores.forward) {
    steps++;
    pos++;
    score = score - (steps === 1 ? 1 : 0.5);
  }

  if (pos === 3 && score > adversaryScores.middle) {
    steps++;
    pos++;
    score = score - (steps === 1 ? 1 : 0.5);
  }

  if (pos === 4 && score > adversaryScores.def) {
    steps++;
    pos++;
    score = score - (steps === 1 ? 1 : 0.5);
  }

  if (pos === 5 && score > adversaryScores.keeper) {
    console.log("MPG GOAL", p.name, p.score, score, adversaryScores);
    p.goals.mpg = 1;
  }
};

const calculateLineScore = (players) => {
  return (
    players
      .map((p) => {
        if (p.virtualSubstitute) {
          return p.virtualSubstitute.virtualRating + p.virtualSubstitute.virtualBonus;
        }
        return p.virtualRating + p.virtualBonus;
      })
      .reduce((score, total) => score + total, 0) / players.length
  );
};

const calculateVirtualScore = (goals) => {
  let score = 0;
  goals.forEach((goal) => {
    if (goal.compo === "out") return;
    if (goal.type === "goal") {
      score += goal.p.goals.goal;
    }
    if (goal.type === "mpg") {
      score++;
    }
    if (goal.type === "own") {
      score += goal.p.goals.own_goal;
    }
  });
  return score;
};

const getMatch = async (matchId, isLive) => {
  let data;
  let dataLive;

  if (isLive) {
    dataLive = await _callApi(`/live/match/mpg_match_${mpgLeagueCode}_${matchId}`);
    data = dataLive;
  } else {
    try {
      dataLive = await _callApi(`/live/match/mpg_match_${mpgLeagueCode}_${matchId}`);
      data = await _callApi(_leagueEndpoint(`/results/${matchId}`));
    } catch (err) {
      console.log(err);
    }
    data = data.data;
  }
  data.id = matchId;
  data.teamHome.goals = [];
  data.teamHome.players = [];
  data.teamHome.substitutePlayers = [];
  data.teamHome.defBonus = defBonus(data.teamHome.composition);
  data.teamAway.goals = [];
  data.teamAway.players = [];
  data.teamAway.substitutePlayers = [];
  data.teamAway.defBonus = defBonus(data.teamAway.composition);
  calculateVirtualPlayers(dataLive.players.home, dataLive.teamHome.substitutes, data.teamHome.defBonus);
  calculateVirtualPlayers(dataLive.players.away, dataLive.teamAway.substitutes, data.teamAway.defBonus);
  calculateMpgGoals(dataLive.players.home, dataLive.players.away);
  data.players.home.forEach((player) => {
    _addPlayer(player, data.teamHome.defBonus, data.teamHome.players, data.teamHome.substitutePlayers);
  });
  dataLive.players.home.forEach((player) => {
    _addPlayerGoals(player, data.teamHome.goals, data.teamAway.goals);
  });
  data.players.away.forEach((player) => {
    _addPlayer(player, data.teamAway.defBonus, data.teamAway.players, data.teamAway.substitutePlayers);
  });
  dataLive.players.away.forEach((player) => {
    _addPlayerGoals(player, data.teamAway.goals, data.teamHome.goals);
  });

  if (isLive && typeof data.teamHome.score === "number") {
    data.teamHome.score = calculateVirtualScore(data.teamHome.goals);
    data.teamAway.score = calculateVirtualScore(data.teamAway.goals);
  }

  return data;
};
module.exports.getMatch = getMatch;
