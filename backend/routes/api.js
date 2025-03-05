const express = require('express');
const Team = require('../models/Team');
const Match = require('../models/Match');
const router = express.Router();

// Get all teams
router.get('/teams', async (req, res) => {
  console.log('GET /api/teams called');
  try {
    const teams = await Team.find();
    if (!teams || teams.length === 0) {
      console.warn('No teams found in database');
      return res.status(404).json({ error: 'No teams found' });
    }
    res.json(teams);
  } catch (err) {
    console.error('Error fetching teams:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Schedule a match with manual toss decision, starting at 0-0
router.post('/matches', async (req, res) => {
  const { team1, team2, overs } = req.body;
  if (!team1 || !team2 || !overs) {
    return res.status(400).json({ error: 'Team1, Team2, and overs are required' });
  }

  const match = new Match({
    team1,
    team2,
    overs,
    toss: null, // No toss yet
    currentBattingTeam: null, // Admin will decide later
    status: 'scheduled', // Start as scheduled
    score: {
      team1: { runs: 0, wickets: 0, overs: 0, players: [] },
      team2: { runs: 0, wickets: 0, overs: 0, players: [] },
    },
    ballByBall: [],
    currentPartnership: { runs: 0, balls: 0 },
    currentBatsmen: { striker: null, nonStriker: null },
    currentBowler: null,
    date: new Date(),
  });
  await match.save();
  res.json(match);
});

// Get match details
router.get('/matches/:id', async (req, res) => {
  console.log('GET /api/matches/:id called with id:', req.params.id);
  const match = await Match.findById(req.params.id).populate('team1 team2');
  if (!match) return res.status(404).json({ error: 'Match not found' });
  res.json(match);
});

// Get all matches
router.get('/matches', async (req, res) => {
  console.log('GET /api/matches called');
  try {
    const matches = await Match.find().populate('team1 team2');
    res.json(matches);
  } catch (err) {
    console.error('Error fetching matches:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Update match toss and batting team
router.patch('/matches/:id', async (req, res) => {
  console.log('PATCH /api/matches/:id called with body:', req.body);
  try {
    const { currentBattingTeam } = req.body;
    const match = await Match.findById(req.params.id).populate('team1 team2');

    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (!currentBattingTeam || (currentBattingTeam !== 'team1' && currentBattingTeam !== 'team2')) {
      return res.status(400).json({ error: 'currentBattingTeam must be "team1" or "team2"' });
    }
    if (match.currentBattingTeam) {
      return res.status(400).json({ error: 'Batting team already decided' });
    }

    match.currentBattingTeam = currentBattingTeam;
    match.toss = currentBattingTeam === 'team1' ? match.team1._id : match.team2._id;
    match.status = 'in-progress';
    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error updating match:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
// Set or update players (flexible selection: striker, bowler, or non-striker in any order)
router.post('/matches/:id/setPlayers', async (req, res) => {
  console.log('Set Players request:', req.body);
  try {
    const { striker, nonStriker, bowler } = req.body;

    const match = await Match.findById(req.params.id).populate('team1 team2');

    if (!match) return res.status(404).json({ error: 'Match not found' });

    const battingTeam = match.currentBattingTeam === 'team1' ? match.team1.players : match.team2.players;
    const bowlingTeam = match.currentBattingTeam === 'team1' ? match.team2.players : match.team1.players;

    console.log('Batting Team Players:', battingTeam.map(p => p.name)); // Debug log
    console.log('Bowling Team Players:', bowlingTeam.map(p => p.name)); // Debug log

    let strikerPlayer, nonStrikerPlayer, bowlerPlayer;

    // Update striker (can be set independently, initial or after wicket)
    if (striker) {
      if (!striker.trim()) return res.status(400).json({ error: 'Striker name cannot be empty' });
      strikerPlayer = battingTeam.find(p => p.name.toLowerCase() === striker.toLowerCase().trim());
      if (!strikerPlayer) return res.status(400).json({ error: `Striker '${striker}' not found in ${battingTeam.map(p => p.name).join(', ')}` });
      match.currentBatsmen.striker = {
        name: strikerPlayer.name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        out: false,
      };
      // Reset non-striker if out or not set, but allow independent setting
      if (match.currentBatsmen.nonStriker?.out || !match.currentBatsmen.nonStriker) {
        match.currentBatsmen.nonStriker = null;
      }
    }

    // Update bowler (can be set independently, initial or after over/wicket)
    if (bowler) {
      if (!bowler.trim()) return res.status(400).json({ error: 'Bowler name cannot be empty' });
      bowlerPlayer = bowlingTeam.find(p => p.name.toLowerCase() === bowler.toLowerCase().trim());
      if (!bowlerPlayer) return res.status(400).json({ error: `Bowler '${bowler}' not found in ${bowlingTeam.map(p => p.name).join(', ')}` });
      match.currentBowler = {
        name: bowlerPlayer.name,
        overs: 0,
        runs: 0,
        wickets: 0,
      };
    }

    // Update non-striker (can be set independently, but must ensure valid state)
    if (nonStriker) {
      if (!nonStriker.trim()) return res.status(400).json({ error: 'Non-striker name cannot be empty' });
      if (!match.currentBatsmen?.striker) {
        return res.status(400).json({ error: 'Striker must be set before non-striker' });
      }
      nonStrikerPlayer = battingTeam.find(p => p.name.toLowerCase() === nonStriker.toLowerCase().trim() && p.name.toLowerCase() !== match.currentBatsmen.striker.name.toLowerCase());
      if (!nonStrikerPlayer) return res.status(400).json({ error: `Non-striker '${nonStriker}' not found in ${battingTeam.map(p => p.name).join(', ')} or conflicts with striker` });
      match.currentBatsmen.nonStriker = {
        name: nonStrikerPlayer.name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        out: false,
      };
    }

    // Ensure at least one field is provided
    if (!striker && !bowler && !nonStriker) {
      return res.status(400).json({ error: 'At least one player (striker, bowler, or non-striker) must be specified' });
    }

    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error setting players:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Update score with cricket logic, starting from 0-0, with over starting at 1.0
// In your router file (backend):

// Update score with cricket logic, including Dot ball
router.post('/matches/:id/update', async (req, res) => {
  console.log('POST /api/matches/:id/update called with body:', req.body);
  try {
    const { event, batsman, bowler, wicketType, runsOnWicket, additionalRuns } = req.body;
    const match = await Match.findById(req.params.id).populate('team1 team2');

    if (!match) return res.status(404).json({ error: 'Match not found' });

    const battingTeamKey = match.currentBattingTeam === 'team1' ? 'team1' : 'team2';
    const bowlingTeamKey = battingTeamKey === 'team1' ? 'team2' : 'team1';
    const battingTeam = match.currentBattingTeam === 'team1' ? match.team1 : match.team2;

    if (!event || typeof event !== 'string' || event.trim() === '') {
      return res.status(400).json({ error: 'Event is required and must be a non-empty string' });
    }

    // Calculate legal deliveries before adding the new ball
    let legalDeliveries = match.ballByBall.filter(b => !['Wide', 'No Ball'].includes(b.event)).length;
    const ballCount = match.ballByBall.length;
    const currentOver = Math.floor(legalDeliveries / 6) + 1; // Use legal deliveries for over count
    const currentBall = legalDeliveries % 6; // Legal balls in current over
    const overString = legalDeliveries === 0 ? '1.0' : `${currentOver}.${currentBall}`;

    let ballEvent = {
      over: currentOver,
      ball: currentBall,
      overString,
      event: event.trim(),
      team: match.currentBattingTeam,
      batsman: batsman || match.currentBatsmen?.striker?.name || '',
      bowler: bowler || match.currentBowler?.name || '',
      wicketType: wicketType || null,
      runsOnWicket: runsOnWicket || 0,
      extraRuns: (event === 'Wide' || event === 'No Ball') ? 1 : 0,
      additionalRuns: additionalRuns || 0,
    };

    if (!match.currentBatsmen?.striker || !match.currentBowler || !match.currentBatsmen?.nonStriker) {
      return res.status(400).json({ error: 'Striker, bowler, and non-striker must be set' });
    }

    const strikerPlayer = match.currentBatsmen.striker;
    const nonStrikerPlayer = match.currentBatsmen.nonStriker;
    const bowlerPlayer = match.currentBowler;

    if (!isNaN(parseInt(event))) { // Runs (1, 2, 3, 4, 6)
      const runs = parseInt(event);
      match.score[battingTeamKey].runs += runs;
      match.score[battingTeamKey].overs += 1 / 6;
      match.currentPartnership.runs += runs;
      match.currentPartnership.balls += 1;

      strikerPlayer.runs += runs;
      strikerPlayer.balls += 1;
      if (runs === 4) strikerPlayer.fours += 1;
      if (runs === 6) strikerPlayer.sixes += 1;

      bowlerPlayer.overs += 1 / 6;
      bowlerPlayer.runs += runs;

      if (runs % 2 === 1) {
        [match.currentBatsmen.striker, match.currentBatsmen.nonStriker] = [
          match.currentBatsmen.nonStriker,
          match.currentBatsmen.striker,
        ];
      }
      legalDeliveries += 1;
    } else if (event === 'Dot') { // Dot Ball
      match.score[battingTeamKey].overs += 1 / 6;
      match.currentPartnership.balls += 1;

      strikerPlayer.balls += 1;
      bowlerPlayer.overs += 1 / 6;

      legalDeliveries += 1;
    } else if (event === 'Wide') { // Wide
      match.score[battingTeamKey].runs += 1;
      bowlerPlayer.runs += 1;
      if (additionalRuns > 0) {
        match.score[battingTeamKey].runs += additionalRuns;
        bowlerPlayer.runs += additionalRuns;
        if (additionalRuns % 2 === 1) {
          [match.currentBatsmen.striker, match.currentBatsmen.nonStriker] = [
            match.currentBatsmen.nonStriker,
            match.currentBatsmen.striker,
          ];
        }
      }
      ballEvent.extraRuns = 1;
      ballEvent.additionalRuns = additionalRuns;
    } else if (event === 'No Ball') { // No Ball
      match.score[battingTeamKey].runs += 1;
      bowlerPlayer.runs += 1;
      if (additionalRuns > 0) {
        match.score[battingTeamKey].runs += additionalRuns;
        bowlerPlayer.runs += additionalRuns;
        strikerPlayer.balls += 1;
        if (additionalRuns % 2 === 1) {
          [match.currentBatsmen.striker, match.currentBatsmen.nonStriker] = [
            match.currentBatsmen.nonStriker,
            match.currentBatsmen.striker,
          ];
        }
      }
      ballEvent.extraRuns = 1;
      ballEvent.additionalRuns = additionalRuns;
    } else if (event === 'Wicket') { // Wicket
      match.score[battingTeamKey].wickets += 1;
      match.score[battingTeamKey].overs += 1 / 6;
      match.currentPartnership.runs = 0;
      match.currentPartnership.balls = 0;

      strikerPlayer.out = true;
      strikerPlayer.balls += 1;

      bowlerPlayer.overs += 1 / 6;
      bowlerPlayer.wickets += 1;
      bowlerPlayer.runs += runsOnWicket || 0;

      ballEvent.wicketType = wicketType || 'Bowled';
      if (wicketType === 'Run Out') {
        match.score[battingTeamKey].runs += runsOnWicket || 0;
        strikerPlayer.runs += runsOnWicket || 0;
      }

      match.currentBatsmen.striker = null;
      legalDeliveries += 1;
    } else {
      return res.status(400).json({ error: `Invalid event type: ${event}` });
    }

    // Only reset bowler after 6 legal deliveries
    if (legalDeliveries > 0 && legalDeliveries % 6 === 0) {
      match.currentBowler = null; // Reset bowler only after a full over of legal deliveries
      [match.currentBatsmen.striker, match.currentBatsmen.nonStriker] = [
        match.currentBatsmen.nonStriker,
        match.currentBatsmen.striker,
      ];
    }

    const totalOvers = match.overs * 6;
    if (legalDeliveries >= totalOvers || match.score[battingTeamKey].wickets === battingTeam.players.length) {
      match.status = 'completed';
      await match.save();
      req.io.emit('scoreUpdate', { ...match.toJSON(), status: 'completed' });
      return res.json({ ...match.toJSON(), status: 'completed' });
    }

    match.ballByBall.push(ballEvent);
    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error updating score:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
// Undo last ball (updated to handle Dot)
router.delete('/matches/:id/ball', async (req, res) => {
  console.log('DELETE /api/matches/:id/ball called with id:', req.params.id);
  try {
    const match = await Match.findById(req.params.id).populate('team1 team2');
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const lastBall = match.ballByBall.pop();
    if (!lastBall) return res.status(400).json({ error: 'No balls to undo' });

    const battingTeamKey = lastBall.team === 'team1' ? 'team1' : 'team2';
    const bowlingTeam = match.currentBattingTeam === 'team1' ? match.team2.players : match.team1.players;

    if (!isNaN(parseInt(lastBall.event))) {
      match.score[battingTeamKey].runs -= parseInt(lastBall.event);
      match.score[battingTeamKey].overs -= 1 / 6;
      match.currentPartnership.runs -= parseInt(lastBall.event);
      match.currentPartnership.balls -= 1;

      const striker = match.currentBatsmen.striker || { runs: 0, balls: 0, fours: 0, sixes: 0 };
      striker.runs -= parseInt(lastBall.event);
      striker.balls -= 1;
      if (parseInt(lastBall.event) === 4) striker.fours -= 1;
      if (parseInt(lastBall.event) === 6) striker.sixes -= 1;

      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { overs: 0, runs: 0 };
      bowlerObj.overs -= 1 / 6;
      bowlerObj.runs -= parseInt(lastBall.event);
    } else if (lastBall.event === 'Dot') {
      match.score[battingTeamKey].overs -= 1 / 6;
      match.currentPartnership.balls -= 1;

      const striker = match.currentBatsmen.striker || { balls: 0 };
      striker.balls -= 1;

      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { overs: 0 };
      bowlerObj.overs -= 1 / 6;
    } else if (lastBall.event === 'Wide' || lastBall.event === 'No Ball') {
      const totalRuns = 1 + (lastBall.additionalRuns || 0);
      match.score[battingTeamKey].runs -= totalRuns;
      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { runs: 0 };
      bowlerObj.runs -= totalRuns;
      if (lastBall.additionalRuns) {
        const striker = match.currentBatsmen.striker || { runs: 0 };
        striker.runs -= lastBall.additionalRuns;
      }
    } else if (lastBall.event === 'Wicket') {
      match.score[battingTeamKey].wickets -= 1;
      match.score[battingTeamKey].overs -= 1 / 6;
      match.currentPartnership.runs = 0;
      match.currentPartnership.balls = 0;

      const strikerOut = match.currentBatsmen.striker || { out: false, balls: 0 };
      strikerOut.out = false;
      strikerOut.balls -= 1;

      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { overs: 0, wickets: 0, runs: 0 };
      bowlerObj.overs -= 1 / 6;
      bowlerObj.wickets -= 1;
      bowlerObj.runs -= (lastBall.runsOnWicket || 0);

      match.currentBatsmen.striker = match.currentBatsmen.striker || null;
    }

    if (match.ballByBall.length % 6 === 0 && match.ballByBall.length > 0) {
      match.currentBowler = null;
    } else if (match.ballByBall.length === 0) {
      match.score[battingTeamKey].overs = 0;
    }

    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error undoing last ball:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
// Undo last ball
router.delete('/matches/:id/ball', async (req, res) => {
  console.log('DELETE /api/matches/:id/ball called with id:', req.params.id);
  try {
    const match = await Match.findById(req.params.id).populate('team1 team2');
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const lastBall = match.ballByBall.pop();

    if (!lastBall) return res.status(400).json({ error: 'No balls to undo' });

    const battingTeamKey = lastBall.team === 'team1' ? 'team1' : 'team2';
    const bowlingTeamKey = battingTeamKey === 'team1' ? 'team2' : 'team1';

    const battingTeam = match.currentBattingTeam === 'team1' ? match.team1.players : match.team2.players;
    const bowlingTeam = match.currentBattingTeam === 'team1' ? match.team2.players : match.team1.players;

    if (!isNaN(parseInt(lastBall.event))) {
      match.score[battingTeamKey].runs -= parseInt(lastBall.event);
      match.score[battingTeamKey].overs -= 1 / 6;
      match.currentPartnership.runs -= parseInt(lastBall.event);
      match.currentPartnership.balls -= 1;

      const striker = match.currentBatsmen.striker || { runs: 0, balls: 0, fours: 0, sixes: 0, out: false };
      striker.runs -= parseInt(lastBall.event);
      striker.balls -= 1;
      if (parseInt(lastBall.event) === 4) striker.fours -= 1;
      if (parseInt(lastBall.event) === 6) striker.sixes -= 1;

      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { overs: 0, runs: 0, wickets: 0 };
      bowlerObj.overs -= 1 / 6;
      bowlerObj.runs -= parseInt(lastBall.event);
    } else if (lastBall.event === 'Wide' || lastBall.event === 'No Ball') {
      const totalRuns = 1 + (lastBall.additionalRuns || 0);
      match.score[battingTeamKey].runs -= totalRuns;
      match.score[battingTeamKey].overs -= 0.1 / 6;
      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { runs: 0 };
      bowlerObj.runs -= totalRuns;
      if (lastBall.additionalRuns) {
        const striker = match.currentBatsmen.striker || { runs: 0 };
        striker.runs -= lastBall.additionalRuns;
      }
    } else if (lastBall.event === 'Wicket') {
      match.score[battingTeamKey].wickets -= 1;
      match.score[battingTeamKey].overs -= 1 / 6;
      match.currentPartnership.runs = 0;
      match.currentPartnership.balls = 0;

      const strikerOut = match.currentBatsmen.striker || { out: false, balls: 0 };
      strikerOut.out = false;
      strikerOut.balls -= 1;

      const bowlerObj = bowlingTeam.find(p => p.name.toLowerCase() === lastBall.bowler.toLowerCase().trim()) || { overs: 0, wickets: 0, runs: 0 };
      bowlerObj.overs -= 1 / 6;
      bowlerObj.wickets -= 1;
      bowlerObj.runs -= (lastBall.runsOnWicket || 0);

      match.currentBatsmen.striker = match.currentBatsmen.striker || null;
      match.currentBowler = match.currentBowler || null;
      match.currentBatsmen.nonStriker = match.currentBatsmen.nonStriker || null;
    }

    // Adjust over if needed after undo
    if (match.ballByBall.length % 6 === 0 && match.ballByBall.length > 0) {
      match.currentBowler = null; // Reset bowler if undoing last ball of over
      // Do not reset striker or non-striker here; they change only after wickets or manually
    } else if (match.ballByBall.length === 0) {
      match.score[battingTeamKey].overs = 0; // Reset overs to 0 if no balls remain
    }

    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error undoing last ball:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Reset match to initial state (0-0)
router.post('/matches/:id/reset', async (req, res) => {
  console.log('POST /api/matches/:id/reset called with id:', req.params.id);
  try {
    const match = await Match.findById(req.params.id).populate('team1 team2');

    if (!match) return res.status(404).json({ error: 'Match not found' });

    const team1Name = match.team1.name;
    const team2Name = match.team2.name;
    const toss = match.toss; // Preserve toss and batting team
    const currentBattingTeam = match.currentBattingTeam;

    // Reset match to initial state (0-0)
    match.status = 'scheduled';
    match.score.team1.runs = 0;
    match.score.team1.wickets = 0;
    match.score.team1.overs = 0;
    match.score.team1.players = match.team1.players.map(p => ({
      name: p.name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      out: false,
    }));
    match.score.team2.runs = 0;
    match.score.team2.wickets = 0;
    match.score.team2.overs = 0;
    match.score.team2.players = match.team2.players.map(p => ({
      name: p.name,
      runs: 0,
      balls: 0,
      fours: 0,
      sixes: 0,
      out: false,
    }));
    match.ballByBall = [];
    match.currentPartnership.runs = 0;
    match.currentPartnership.balls = 0;
    match.currentBatsmen.striker = null;
    match.currentBatsmen.nonStriker = null;
    match.currentBowler = null;
    match.toss = toss;
    match.currentBattingTeam = currentBattingTeam;

    await match.save();
    req.io.emit('scoreUpdate', match);
    res.json(match);
  } catch (err) {
    console.error('Error resetting match:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Reset all matches in MongoDB to initial state
router.post('/matches/resetAll', async (req, res) => {
  console.log('POST /api/matches/resetAll called');
  try {
    const matches = await Match.find().populate('team1 team2');
    for (const match of matches) {
      match.status = 'scheduled';
      match.score.team1.runs = 0;
      match.score.team1.wickets = 0;
      match.score.team1.overs = 0;
      match.score.team1.players = match.team1.players.map(p => ({
        name: p.name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        out: false,
      }));
      match.score.team2.runs = 0;
      match.score.team2.wickets = 0;
      match.score.team2.overs = 0;
      match.score.team2.players = match.team2.players.map(p => ({
        name: p.name,
        runs: 0,
        balls: 0,
        fours: 0,
        sixes: 0,
        out: false,
      }));
      match.ballByBall = [];
      match.currentPartnership.runs = 0;
      match.currentPartnership.balls = 0;
      match.currentBatsmen.striker = null;
      match.currentBatsmen.nonStriker = null;
      match.currentBowler = null;
      await match.save();
    }
    req.io.emit('scoreUpdate', matches);
    res.json({ message: 'All matches reset successfully' });
  } catch (err) {
    console.error('Error resetting all matches:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

module.exports = router;    