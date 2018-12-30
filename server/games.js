 var assert = require('better-assert');
 var async = require('async');
 var AsyncCache = require ('async-cache');
 var timeago = require('node-time-ago');
 var database = require('./database');

 /**
  * GET
  * Public API
  * Show a single game info
  **/
exports.show = function(req, res, next) {
    var user = req.user;
    var gameId = parseInt(req.params.id);

    if (!gameId || typeof gameId !== 'number') return res.render('404');

    database.getGame(gameId, function(err, game) {
        if (err) {
            if (err === 'GAME_DOES_NOT_EXISTS')
                return res.render('404');

            return next(new Error('Unable to get game: \n' + err));
        }

        database.getGamesPlays(game.id, function(err, plays) {
            if (err)
                return next(new Error('Unable to get game information: \n' + err)); //If getGame worked this should work too

            game.timeago = timeago(game.created);
            res.render('game', { game: game, plays: plays, user: user });
        });
    });
};

 /**
  * GET
  * Public API
  * Shows the leader board
  **/
 exports.getLeaderBoard = function(req, res, next) {
     var user = req.user;
     var by = req.query.by;

     var byDb, order;
     switch(by) {
         case 'net_desc':
             byDb = 'net_profit';
             order = 'DESC';
             break;
         case 'net_asc':
             byDb = 'net_profit';
             order = 'ASC';
             break;
         default :
             byDb = 'gross_profit';
             order = 'DESC';
     }

     database.getLeaderBoard(byDb, order ,function(err, leaders) {
         if (err)
             return next(new Error('Unable to get leader board: \n' + err));

        res.render('leaderboard', { user: user, leaders: leaders, sortBy: byDb, order: order });
     });
 };

 exports.getLeaderBoardInfo = function(req, res, next) {
    var user = req.user;
    var by = req.query.by;

    var byDb, order;
    switch(by) {
        case 'net_desc':
            byDb = 'net_profit';
            order = 'DESC';
            break;
        case 'net_asc':
            byDb = 'net_profit';
            order = 'ASC';
            break;
        default :
            byDb = 'gross_profit';
            order = 'DESC';
    }

    database.getLeaderBoard(byDb, order ,function(err, leaders) {
        if (err)
            return next(new Error('Unable to get leader board: \n' + err));

       res.json({ user: user, leaders: leaders, sortBy: byDb, order: order });
    });
};





 /**
  * GET
  * Public API
  * Shows the loser board
  **/

 var loserBoard = new AsyncCache({
   max: 2,
   maxAge: 1000 * 10, // 10 sec
   load: function (key, cb) {
     database.getLoserBoard(cb)
   }
 });

 exports.getLoserBoard = function(req, res, next) {
   var user = req.user;

   loserBoard.get('noop', function(err, losers) {
     if (err)
       return next(new Error('Unable to get leader board: \n' + err));

     res.render('loserboard', { user: req.user, losers: losers });
   });
 };





 /**
  * GET
  * Public API
  * Show a single game info
  **/
 exports.getGameInfoJson = function(req, res, next) {
    var gameId = parseInt(req.params.id);

    if (!gameId || typeof gameId !== 'number')
        return res.sendStatus(400);

    database.getGameInfo(gameId, function(err, game) {
        if (err) {
            if (err === 'GAME_DOES_NOT_EXISTS')
                return res.json(err);

            console.error('[INTERNAL_ERROR] Unable to get game info. gameId: ', gameId);
            return res.sendStatus(500);
        }
        res.json(game);
    });
 };

