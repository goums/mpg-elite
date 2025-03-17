"use strict";

const debug = require("debug")("mpg:api");
const https = require("https");
const { isNumber } = require("util");
const db = require("./db");

let mpgSessionToken = null;
let mpgToken = null;

const mpgLeague = process.env.MPG_LEAGUE;
const mpgSeason = process.env.MPG_SEASON;
const mpgDivision = process.env.MPG_DIVISION;

const initTokens = async () => {
  mpgSessionToken = await db.getConfig("MPG_SESSION_TOKEN");
  mpgToken = await db.getConfig("MPG_TOKEN");
}

const _leagueEndpoint = (endpoint = "", league = mpgLeague) => `/league/${league}${endpoint}`;
const _divisionEndpoint = (endpoint = "", league = mpgLeague, season = mpgSeason, division = mpgDivision) =>
  `/division/mpg_division_${league}_${season}_${division}${endpoint}`;

const _refreshAuthToken = async () => {
  debug("Refreshing authentication token");
  const newTokens = await new Promise((resolve, reject) => {
    
    // Split the cookie string into individual cookies
    const cookies = {
      "__session": mpgSessionToken
    };
    
    // Build the cookie string from the map
    const cookieString = Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');
    
    const options = {
      hostname: "mpg.football",
      path: "/auth/refresh",
      method: "GET",
      headers: {
        Cookie: cookieString,
        "Referer": "https://mpg.football/matches/live"
      }
    };
    
    const req = https.request(options, (res) => {
      res.setEncoding("utf8");
      const body = [];
      res.on("data", (chunk) => body.push(chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const parsedData = JSON.parse(body.join(""));
            debug(`Refresh token response: ${JSON.stringify(parsedData)}`);
            if (parsedData.accessToken) {
              debug("Successfully refreshed auth token");
              
              // Get the new session token from cookies in response headers
              let newSessionToken = null;
              try {
                const setCookieHeaders = res.headers['set-cookie'] || [];
                for (const cookieStr of setCookieHeaders) {
                  if (cookieStr.startsWith('__session=')) {
                    newSessionToken = cookieStr.split(';')[0].split('=')[1];
                    debug("New session token retrieved from response");
                    break;
                  }
                }
              } catch (error) {
                debug("Error extracting session token from response:", error);
              }
              
              resolve({
                mpgToken: parsedData.accessToken,
                mpgSessionToken: newSessionToken || mpgSessionToken
              });
            } else {
              debug("No access token in refresh response");
              reject(new Error("Failed to refresh authentication token"));
            }
          } catch (error) {
            debug("Error parsing refresh token response:", error);
            reject(new Error("Failed to parse refresh token response"));
          }
        } else {
          debug(`Token refresh failed with status: ${res.statusCode}`);
          reject(new Error(`Token refresh failed: ${res.statusCode}`));
        }
      });
    });
    
    req.on("error", (error) => {
      debug("Token refresh request error:", error.message);
      reject(error);
    });
    
    req.end();
  });

  mpgToken = newTokens.mpgToken;
  mpgSessionToken = newTokens.mpgSessionToken;
  await db.setConfig("MPG_TOKEN", mpgToken);
  await db.setConfig("MPG_SESSION_TOKEN", mpgSessionToken);
};

const _callApi = async (endpoint, attemptedRefresh = false) => {
  if(!mpgToken) await initTokens();

  const options = {
    hostname: "api.mpg.football",
    path: endpoint,
    headers: {
      Authorization: mpgToken,
      platform: "ios",
      "client-version": "8.9.2",
      "api-version": "5"
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
          if (res.statusCode === 401 && !attemptedRefresh) {
            debug("Authentication error: 401 Unauthorized");
            // Try to refresh the token and retry the request, but only once
            _refreshAuthToken()
              .then(() => {
                debug("Retrying request with new token");
                return _callApi(endpoint, true); // Mark that we've attempted a refresh
              })
              .then(resolve)
              .catch(error => {
                debug("Token refresh failed:", error.message);
                reject(new Error("Authentication failed: Unable to refresh token"));
              });
          } else {
            try {
              const parsedData = JSON.parse(body.join(""));
              resolve(parsedData);
            } catch (error) {
              debug("Error parsing JSON response:", error);
              reject(new Error("Failed to parse API response"));
            }
          }
        });
      })
      .on("error", (error) => {
        debug("API request error:", error.message);
        reject(error);
      });
  });
};

let mpgTeamsData = null;
const _getTeamsData = async () => {
  if (!mpgTeamsData) mpgTeamsData = await _callApi(_divisionEndpoint("/teams"));
  return mpgTeamsData;
};

let mpgClubsData = null;
const _getClubsData = async () => {
  if (!mpgClubsData) {
    const { championshipClubs } = await _callApi(`/championship-clubs`);
    mpgClubsData = championshipClubs;
  }
  return mpgClubsData;
};

const _createTeamRank = (team, userId, rank) => {
  return {
    userId,
    name: team.name,
    target: rank.targetMan,
    symbol: team.abbreviation,
    icon: team.jerseyUrl,
    points: rank.points,
    played: rank.played,
    wins: rank.won,
    loses: rank.lost,
    draws: rank.drawn,
    goalFor: rank.goals,
    goalAgainst: rank.goalsConceded,
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

const _getSeasonRanking = async (season) => {
  const [divisionData, teamsData, rankingData, calendarData] = await Promise.all([
    _callApi(_divisionEndpoint("", mpgLeague, season)),
    _callApi(_divisionEndpoint("/teams", mpgLeague, season)),
    _callApi(_divisionEndpoint("/ranking/standings", mpgLeague, season)),
    _callApi(_divisionEndpoint("/calendar", mpgLeague, season))
  ]);

  let targetMan = 0;
  calendarData.fixtures.forEach((f) => {
    if (f.previousTargetMan) targetMan = f.previousTargetMan;
    if (f.afterTargetMan) targetMan = f.afterTargetMan;
  });

  const users = {};
  Object.keys(divisionData.usersTeams).forEach((k) => (users[divisionData.usersTeams[k]] = k));
  if (rankingData?.standings) {
    return rankingData.standings.map((rank) => {
      rank.targetMan = rank.teamId === targetMan;
      return _createTeamRank(
        teamsData.find((t) => t.id === rank.teamId),
        users[rank.teamId],
        rank
      );
    });
  } else {
    return teamsData.map((team) =>
      _createTeamRank(team, users[team.id], {
        targetMan: team.id === targetMan,
        points: 0,
        played: 0,
        won: 0,
        lost: 0,
        drawn: 0,
        goals: 0,
        goalsConceded: 0,
        difference: 0,
        series: ""
      })
    );
  }
};

module.exports.getFirstPhaseRanking = async () => {
  const season = (parseInt(mpgSeason) - 1).toString();
  return _getSeasonRanking(season);
};

module.exports.getSecondPhaseRanking = async () => {
  return _getSeasonRanking(mpgSeason);
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
  const divisionData = await _callApi(_divisionEndpoint());
  if (!day) day = divisionData.liveState.currentGameWeek;
  day = parseInt(day);

  const { divisionMatches } = await _callApi(_divisionEndpoint(`/game-week/${day}/matches`));
  const chId = divisionMatches[0].championshipId;
  const chSeason = divisionMatches[0].championshipSeason;
  const chWeek = divisionMatches[0].championshipGameWeekNumber;

  const [chData, calendarData, teamsData] = await Promise.all([
    _callApi(`/championship-matches/${chId}/season/${chSeason}/game-week/${chWeek}`),
    _callApi(_divisionEndpoint("/calendar")),
    _getTeamsData()
  ]);

  const matches = divisionMatches.map((match) => {
    const teamHome = teamsData.find((t) => t.id === match.home.teamId);
    match.teamHome = {
      ...match.home,
      ...teamHome,
      targetMan: calendarData.fixtures[day - 1].previousTargetMan === teamHome.id
    };

    const teamAway = teamsData.find((t) => t.id === match.away.teamId);
    match.teamAway = {
      ...match.away,
      ...teamAway,
      targetMan: calendarData.fixtures[day - 1].previousTargetMan === teamAway.id
    };
    return match;
  });

  const results = {
    currentMatchDay: day,
    maxMatchDay: divisionData.liveState.totalGameWeeks,
    date: chData.matches[0].date,
    matches
  };
  //retrieve full match details
  if (new Date(results.date) < new Date()) {
    results.matches = await Promise.all(results.matches.map(async (match) => getMatch(match.id)));
    if (results.matches[0].live) results.live = true;
  }
  return results;
};

const _addPlayer = (player, teamPlayers, teamSubstitutes) => {
  if (!player.playerId && !player.id) return;

  player.bonus = player.bonusRating;

  if (parseInt(player.number) <= 11) {
    teamPlayers.push(player);
  } else {
    teamSubstitutes.push(player);
  }
};

const _addPlayerGoals = (player, teamGoals, adversaryGoals) => {
  if (!player.playerId && !player.id) return;
  if (parseInt(player.number) > 11) return;
  if (player.isVirtualSubstitue) return;

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

const calculateVirtualPlayers = (players, substitutes) => {
  substitutes.forEach((s) => {
    s.subPlayer = players.find((p) => p.playerId === s.subId);
  });
  let availableSubstitutes = players.filter((p) => parseInt(p.originNumber) > 11 && p.position > 1);

  players.forEach((p) => {
    //set default rating and bonus if missing
    const isRotaldo = p.starter === -1 || (p.starter === 2 && !p.rating);
    if (isRotaldo) console.log(`ROTALDO => ${p.name}`);
    p.virtualRating = isRotaldo ? 2.5 : p.rating ?? 5;
    p.virtualBonus = p.bonusRating;

    //check tactical substitute
    const subTact = substitutes.find((s) => s.starterId === p.playerId);
    if (subTact && p.virtualRating + p.virtualBonus < subTact.rating) {
      if (subTact.subPlayer && subTact.subPlayer.rating) {
        p.virtualSubstitute = subTact.subPlayer;
        subTact.subPlayer.isVirtualSubstitue = true;
        //remove substitute from available ones
        availableSubstitutes = availableSubstitutes.filter((s) => s.playerId !== subTact.subId);
      }
    }

    //check keeper auto substitute
    if (isRotaldo && p.position === 1 && parseInt(p.originNumber) <= 11) {
      const sub = players.find((s) => s.position === 1 && s.playerId !== p.playerId);
      if (sub && sub.rating) {
        console.log(`GOAL SUBSTITUE: ${sub.name} replace ${p.name}`);
        p.virtualSubstitute = sub;
        sub.isVirtualSubstitue = true;
      }
    }
  });

  //check default substitute
  console.log("original substitutes:", substitutes.map((s) => s.subPlayer.name).join(","));
  console.log("available substitutes:", availableSubstitutes.map((s) => s.name).join(","));

  const notPlayed = players.filter(
    (p) =>
      (p.starter === -1 || (p.starter === 2 && !p.rating)) && parseInt(p.originNumber) <= 11 && !p.virtualSubstitute
  );
  console.log("rotaldo??", notPlayed.map((s) => s.name).join(","));
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
          subPlayer.isVirtualSubstitue = true;
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
    keeper: calculateLineScore(homePlayers.filter((p) => p.position === 1 && parseInt(p.originNumber) <= 11)),
    def: calculateLineScore(homePlayers.filter((p) => p.position === 2 && parseInt(p.originNumber) <= 11)),
    middle: calculateLineScore(homePlayers.filter((p) => p.position === 3 && parseInt(p.originNumber) <= 11)),
    forward: calculateLineScore(homePlayers.filter((p) => p.position === 4 && parseInt(p.originNumber) <= 11))
  };
  console.log("homeScores", homeScores);

  const awayScores = {
    keeper: calculateLineScore(awayPlayers.filter((p) => p.position === 1 && parseInt(p.originNumber) <= 11)),
    def: calculateLineScore(awayPlayers.filter((p) => p.position === 2 && parseInt(p.originNumber) <= 11)),
    middle: calculateLineScore(awayPlayers.filter((p) => p.position === 3 && parseInt(p.originNumber) <= 11)),
    forward: calculateLineScore(awayPlayers.filter((p) => p.position === 4 && parseInt(p.originNumber) <= 11))
  };

  console.log("awayScores", awayScores);

  //calculate MPG goals...
  homePlayers
    .filter((p) => p.position > 1 && parseInt(p.originNumber) <= 11 && p.goals?.goal === 0)
    .forEach((p) => {
      calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus + 0.01, awayScores);
      if (p.virtualSubstitute && p.virtualSubstitute.goals?.goal === 0) {
        p = p.virtualSubstitute;
        calculatePlayerMpgGoal(p, p.virtualRating + p.virtualBonus + 0.01, awayScores);
      }
    });

  awayPlayers
    .filter((p) => p.position > 1 && parseInt(p.originNumber) <= 11 && p.goals?.goal === 0)
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

const _reformatPlayers = (players, clubsData, captain) => {
  return players.map((p) => {
    if (p.clubId) {
      p.jerseyUrl = clubsData[p.clubId].defaultJerseyUrl;
    }
    p.name = p.lastName;
    p.teamid = p.clubId ? p.clubId.split("_").pop() : 0;
    p.starter = p.status ? (p.status > 2 ? -1 : p.status) : p.compositionStatus > 2 ? -1 : p.compositionStatus;
    p.goals = {
      mpg: p.mpgGoals ?? 0,
      goal: p.goals ?? 0,
      own_goal: p.ownGoals ?? 0
    };
    if (p.playerId === captain) p.captain = true;
    return p;
  });
};

const getMatch = async (matchId) => {
  const [
    matchData,
    teamsData,
    clubsData
    //calendarData
  ] = await Promise.all([
    _callApi(_divisionEndpoint(`/match/${matchId}`)),
    _getTeamsData(),
    _getClubsData()
    //_callApi(_divisionEndpoint("/calendar"))
  ]);

  const teamHome = teamsData.find((t) => t.id === matchData.home.teamId);
  matchData.teamHome = {
    jerseyUrl: teamHome.jerseyUrl,
    name: teamHome.name,
    abbr: teamHome.abbreviation,
    goals: [],
    players: [],
    substitutePlayers: [],
    substitutes: matchData.home.tacticalSubs.map((sub) => {
      sub.substituteName = matchData.home.players[sub.subId].lastName;
      sub.starterName = matchData.home.players[sub.starterId].lastName;
      return sub;
    }),
    score: matchData.home.score,
    composition: matchData.home.composition
  };
  const teamAway = teamsData.find((t) => t.id === matchData.away.teamId);
  matchData.teamAway = {
    jerseyUrl: teamAway.jerseyUrl,
    name: teamAway.name,
    abbr: teamAway.abbreviation,
    goals: [],
    players: [],
    substitutePlayers: [],
    substitutes: matchData.away.tacticalSubs.map((sub) => {
      sub.substituteName = matchData.away.players[sub.subId].lastName;
      sub.starterName = matchData.away.players[sub.starterId].lastName;
      return sub;
    }),
    score: matchData.away.score,
    composition: matchData.away.composition
  };

  const homeAlreadyOnPitch = {};
  Object.keys(matchData.home.playersOnPitch).forEach((number) => {
    const onPitch = matchData.home.playersOnPitch[number];
    if (onPitch.playerId) {
      if (homeAlreadyOnPitch[onPitch.playerId]) return;
      homeAlreadyOnPitch[onPitch.playerId] = true;

      if (onPitch.isSub === "mandatory" && !onPitch.starterId) {
        // Retreive original starter player at this position
        Object.keys(matchData.home.playersOnPitch).forEach((num) => {
          if (num !== number && matchData.home.playersOnPitch[num].playerId === onPitch.playerId) {
            onPitch.starterId = matchData.home.playersOnPitch[num].starterId;
          }
        });
      }
      // Calculate original position number
      const originalPlayerId = number <= 11 ? onPitch.starterId ?? onPitch.playerId : onPitch.playerId;
      matchData.home.players[originalPlayerId].originNumber = number;

      // And add effective position number
      if (number <= 11) matchData.home.players[onPitch.playerId].number = number;
      else if (onPitch.starterId) matchData.home.players[onPitch.starterId].number = number;
      else matchData.home.players[onPitch.playerId].number = number;
    }
  });
  const homePlayers = _reformatPlayers(Object.values(matchData.home.players), clubsData, matchData.home.captain);
  const awayAlreadyOnPitch = {};
  Object.keys(matchData.away.playersOnPitch).forEach((number) => {
    const onPitch = matchData.away.playersOnPitch[number];
    if (onPitch.playerId) {
      if (awayAlreadyOnPitch[onPitch.playerId]) return;
      awayAlreadyOnPitch[onPitch.playerId] = true;

      if (onPitch.isSub === "mandatory" && !onPitch.starterId) {
        // Retreive original starter player at this position
        Object.keys(matchData.away.playersOnPitch).forEach((num) => {
          if (num !== number && matchData.away.playersOnPitch[num].playerId === onPitch.playerId) {
            onPitch.starterId = matchData.away.playersOnPitch[num].starterId;
          }
        });
      }
      // Calculate original position number
      const originalPlayerId = number <= 11 ? onPitch.starterId ?? onPitch.playerId : onPitch.playerId;
      matchData.away.players[originalPlayerId].originNumber = number;

      // And add effective position number
      if (number <= 11) matchData.away.players[onPitch.playerId].number = number;
      else if (onPitch.starterId) matchData.away.players[onPitch.starterId].number = number;
      else matchData.away.players[onPitch.playerId].number = number;
    }
  });
  const awayPlayers = _reformatPlayers(Object.values(matchData.away.players), clubsData, matchData.away.captain);
  calculateVirtualPlayers(homePlayers, matchData.home.tacticalSubs);
  calculateVirtualPlayers(awayPlayers, matchData.away.tacticalSubs);
  calculateMpgGoals(homePlayers, awayPlayers);
  homePlayers.forEach((player) => {
    _addPlayer(player, matchData.teamHome.players, matchData.teamHome.substitutePlayers);
    _addPlayerGoals(player, matchData.teamHome.goals, matchData.teamAway.goals);
  });
  awayPlayers.forEach((player) => {
    _addPlayer(player, matchData.teamAway.players, matchData.teamAway.substitutePlayers);
    _addPlayerGoals(player, matchData.teamAway.goals, matchData.teamHome.goals);
  });

  if (matchData.status === 1) {
    matchData.live = true;
    matchData.teamHome.score = calculateVirtualScore(matchData.teamHome.goals);
    matchData.teamAway.score = calculateVirtualScore(matchData.teamAway.goals);
  }

  matchData.dateMatch = Object.values(matchData.championshipMatches)[0].date;
  matchData.matchDay = matchData.divisionGameWeek;
  return matchData;
};
module.exports.getMatch = getMatch;
