var assert = require('better-assert');
var async = require('async');
// var bitcoinjs = require('bitcoinjs-lib');
var request = require('request');
var timeago = require('node-time-ago');
var lib = require('./lib');
var database = require('./database');
var withdraw = require('./withdraw');
var sendEmail = require('./sendEmail');
var speakeasy = require('speakeasy');
var qr = require('qr-image');
var uuid = require('uuid');
var _ = require('lodash');
var config = require('../config/config');
var wallet = require('./wallet');

var sessionOptions = {
    httpOnly: true,
    secure : config.PRODUCTION
};

/**
 * POST
 * Public API
 * Register a user
 */
exports.register  = function(req, res, next) {
    var values = _.merge(req.body, { user: {} });
    var username = lib.removeNullsAndTrim(values.user.name);
    var password = lib.removeNullsAndTrim(values.user.password);
    var password2 = lib.removeNullsAndTrim(values.user.confirm);
    var email = lib.removeNullsAndTrim(values.user.email);
    var ipAddress = req.ip;
    var userAgent = req.get('user-agent');

    var notValid = lib.isInvalidUsername(username);
    if (notValid) return res.render('register', { warning: 'username not valid because: ' + notValid, values: values.user });

    // stop new registrations of >16 char usernames
    if (username.length > 16)
        return res.render('register', { warning: 'Username is too long', values: values.user });

    notValid = lib.isInvalidPassword(password);
    if (notValid) {
        values.user.password = null;
        values.user.confirm = null;
        return res.render('register', { warning: 'password not valid because: ' + notValid, values: values.user });
    }

    if (email) {
        notValid = lib.isInvalidEmail(email);
        if (notValid) return res.render('register', { warning: 'email not valid because: ' + notValid, values: values.user });
    }

    // Ensure password and confirmation match
    if (password !== password2) {
        return res.render('register', {
          warning: 'password and confirmation did not match'
        });
    }

    database.createUser(username, password, email, ipAddress, userAgent, function(err, sessionId) {
        if (err) {
            if (err === 'USERNAME_TAKEN') {
                values.user.name = null;
                return res.render('register', { warning: 'User name taken...', values: values.user});
            }
            return next(new Error('Unable to register user: \n' + err));
        }
        database.getUserBySessionId(sessionId, function(error, user) {
            wallet.createWallet(user, function(createWalletErr, createWalletRes) {
                if (createWalletErr) {
                    console.log("wallet Create result", createWalletErr);
                    database.deleteUser(user.id);
                    return res.redirect('/register');
                } else {
                    console.log("wallet Create result", createWalletRes);
                    res.cookie('id', sessionId, sessionOptions);
                    return res.redirect('/');
                }
            })
        })
    });
};

/**
 * POST
 * Public API
 * Login a user
 */
exports.login = function(req, res, next) {
    var username = lib.removeNullsAndTrim(req.body.username);
    var password = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);
    var remember = !!req.body.remember;
    var ipAddress = req.ip;
    var userAgent = req.get('user-agent');

    if (!username || !password)
        return res.render('login', { warning: 'no username or password' });

    database.validateUser(username, password, otp, function(err, userId) {
        if (err) {
            console.log('[Login] Error for ', username, ' err: ', err);

            if (err === 'NO_USER')
                return res.render('login',{ warning: 'Username does not exist' });
            if (err === 'WRONG_PASSWORD')
                return res.render('login', { warning: 'Invalid password' });
            if (err === 'INVALID_OTP') {
                var warning = otp ? 'Invalid one-time password' : undefined;
                return res.render('login-mfa', { username: username, password: password, warning: warning });
            }
            return next(new Error('Unable to validate user ' + username + ': \n' + err));
        }
        assert(userId);

        database.createSession(userId, ipAddress, userAgent, remember, function(err, sessionId, expires) {
            if (err)
                return next(new Error('Unable to create session for userid ' + userId +  ':\n' + err));

            if(remember)
                sessionOptions.expires = expires;

            res.cookie('id', sessionId, sessionOptions);
            res.redirect('/');
        });
    });
};

/**
 * POST
 * Logged API
 * Logout the current user
 */
exports.logout = function(req, res, next) {
    var sessionId = req.cookies.id;
    var userId = req.user.id;

    assert(sessionId && userId);

    database.expireSessionsByUserId(userId, function(err) {
        if (err)
            return next(new Error('Unable to logout got error: \n' + err));
        res.redirect('/');
    });
};

/**
 * POST
 * Logged API
 * Logout the current user
 */
exports.newLogout = function(req, res, next) {
    var sessionId = req.cookies.id;
    var userId = req.user.id;

    assert(sessionId && userId);

    database.expireSessionsByUserId(userId, function(err) {
        if (err)
            return res.status(500).send('Unable to logout got error');
        res.json({msg: 'ok'});
    });
};

/**
 * GET
 * Logged API
 * Shows the graph of the user profit and games
 */
exports.profile = function(req, res, next) {

    var user = req.user; //If logged here is the user info
    var username = lib.removeNullsAndTrim(req.params.name);

    var page = null;
    if (req.query.p) { //The page requested or last
        page = parseInt(req.query.p);
        if (!Number.isFinite(page) || page < 0)
            return next('Invalid page');
    }

    if (!username)
        return next('No username in profile');

    database.getPublicStats(username, function(err, stats) {
        if (err) {
            if (err === 'USER_DOES_NOT_EXIST')
               return next('User does not exist');
            else
                return next(new Error('Cant get public stats: \n' + err));
        }

        /**
         * Pagination
         * If the page number is undefined it shows the last page
         * If the page number is given it shows that page
         * It starts counting from zero
         */

        var resultsPerPage = 50;
        var pages = Math.floor(stats.games_played / resultsPerPage);

        if (page && page >= pages)
            return next('User does not have page ', page);

        // first page absorbs all overflow
        var firstPageResultCount = stats.games_played - ((pages-1) * resultsPerPage);

        var showing = page ? resultsPerPage : firstPageResultCount;
        var offset = page ? (firstPageResultCount + ((pages - page - 1) * resultsPerPage)) : 0 ;

        if (offset > 100000) {
          return next('Sorry we can\'t show games that far back :( ');
        }

        var tasks = [
            function(callback) {
                database.getUserNetProfitLast(stats.user_id, showing + offset, callback);
            },
            function(callback) {
                database.getUserPlays(stats.user_id, showing, offset, callback);
            }
        ];


        async.parallel(tasks, function(err, results) {
            if (err) return next(new Error('Error getting user profit: \n' + err));

            var lastProfit = results[0];

            var netProfitOffset = stats.net_profit - lastProfit;
            var plays = results[1];


            if (!lib.isInt(netProfitOffset))
                return next(new Error('Internal profit calc error: ' + username + ' does not have an integer net profit offset'));

            assert(plays);

            plays.forEach(function(play) {
                play.timeago = timeago(play.created);
            });

            var previousPage;
            if (pages > 1) {
                if (page && page >= 2)
                    previousPage = '?p=' + (page - 1);
                else if (!page)
                    previousPage = '?p=' + (pages - 1);
            }

            var nextPage;
            if (pages > 1) {
                if (page && page < (pages-1))
                    nextPage ='?p=' + (page + 1);
                else if (page && page == pages-1)
                    nextPage = stats.username;
            }

            res.render('user', {
                user: user,
                stats: stats,
                plays: plays,
                net_profit_offset: netProfitOffset,
                showing_last: !!page,
                previous_page: previousPage,
                next_page: nextPage,
                games_from: stats.games_played-(offset + showing - 1),
                games_to: stats.games_played-offset,
                pages: {
                    current: page == 0 ? 1 : page + 1 ,
                    total: Math.ceil(stats.games_played / 100)
                }
            });
        });

    });
};

/**
 * GET
 * Shows the request bits page
 * Restricted API to logged users
 **/
exports.request = function(req, res) {
    var user = req.user; //Login var
    assert(user);

    res.render('request', { user: user });
};

/**
 * POST
 * Process the give away requests
 * Restricted API to logged users
 **/
exports.giveawayRequest = function(req, res, next) {
    var user = req.user;
    assert(user);

    database.addGiveaway(user.id, function(err) {
        if (err) {
            if (err.message === 'NOT_ELIGIBLE') {
                return res.render('request', { user: user, warning: 'You have to wait ' + err.time + ' minutes for your next give away.' });
            } else if(err === 'USER_DOES_NOT_EXIST') {
                return res.render('error', { error: 'User does not exist.' });
            }

            return next(new Error('Unable to add giveaway: \n' + err));
        }
        user.eligible = 240;
        user.balance_satoshis += 200;
        return res.redirect('/play-old?m=received');
    });

};

/**
 * GET
 * Restricted API
 * Shows the account page, the default account page.
 **/
exports.account = function(req, res, next) {
    var user = req.user;
    assert(user);

    var tasks = [
        function(callback) {
            database.getDepositsAmount(user.id, callback);
        },
        function(callback) {
            database.getWithdrawalsAmount(user.id, callback);
        },
        function(callback) {
            database.getGiveAwaysAmount(user.id, callback);
        },
        function(callback) {
            database.getUserNetProfit(user.id, callback)
        }
    ];

    async.parallel(tasks, function(err, ret) {
        if (err)
            return next(new Error('Unable to get account info: \n' + err));

        var deposits = ret[0];
        var withdrawals = ret[1];
        var giveaways = ret[2];
        var net = ret[3];
        user.deposits = !deposits.sum ? 0 : deposits.sum;
        user.withdrawals = !withdrawals.sum ? 0 : withdrawals.sum;
        user.giveaways = !giveaways.sum ? 0 : giveaways.sum;
        user.net_profit = net.profit;
        wallet.getWallet(user, function(error, result){
            user.deposit_address = result;
            res.render('account', { user: user });
        });
    });
};

exports.accountInfo = function(req, res, next) {
    var user = req.user;
    assert(user);

    var tasks = [
        function(callback) {
            database.getDepositsAmount(user.id, callback);
        },
        function(callback) {
            database.getWithdrawalsAmount(user.id, callback);
        },
        function(callback) {
            database.getGiveAwaysAmount(user.id, callback);
        },
        function(callback) {
            database.getUserNetProfit(user.id, callback)
        }
    ];

    async.parallel(tasks, function(err, ret) {
        if (err)
            return next(new Error('Unable to get account info: \n' + err));

        var deposits = ret[0];
        var withdrawals = ret[1];
        var giveaways = ret[2];
        var net = ret[3];
        user.deposits = !deposits.sum ? 0 : deposits.sum;
        user.withdrawals = !withdrawals.sum ? 0 : withdrawals.sum;
        user.giveaways = !giveaways.sum ? 0 : giveaways.sum;
        user.net_profit = net.profit;
        wallet.getWallet(user, function(error, result){
            user.deposit_address = result;
            console.log("accountInfo NetProfit", user.net_profit);
            res.json({ user: user });
        });
    });
};

/**
 * POST
 * Restricted API
 * Change the user's password
 **/
exports.resetPassword = function(req, res, next) {
    var user = req.user;
    assert(user);
    var password = lib.removeNullsAndTrim(req.body.old_password);
    var newPassword = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);
    var confirm = lib.removeNullsAndTrim(req.body.confirmation);
    var ipAddress = req.ip;
    var userAgent = req.get('user-agent');

    if (!password) return  res.redirect('/security?err=Enter%20your%20old%20password');

    var notValid = lib.isInvalidPassword(newPassword);
    if (notValid) return res.redirect('/security?err=new%20password%20not%20valid:' + notValid);

    if (newPassword !== confirm) return  res.redirect('/security?err=new%20password%20and%20confirmation%20should%20be%20the%20same.');

    database.validateUser(user.username, password, otp, function(err, userId) {
        if (err) {
            if (err  === 'WRONG_PASSWORD') return  res.redirect('/security?err=wrong password.');
            if (err === 'INVALID_OTP') return res.redirect('/security?err=invalid one-time password.');
            //Should be an user here
            return next(new Error('Unable to reset password: \n' + err));
        }
        assert(userId === user.id);
        database.changeUserPassword(user.id, newPassword, function(err) {
            if (err)
                return next(new Error('Unable to change user password: \n' +  err));

            database.expireSessionsByUserId(user.id, function(err) {
                if (err)
                    return next(new Error('Unable to delete user sessions for userId: ' + user.id + ': \n' + err));

                database.createSession(user.id, ipAddress, userAgent, false, function(err, sessionId) {
                    if (err)
                        return next(new Error('Unable to create session for userid ' + userId +  ':\n' + err));

                    res.cookie('id', sessionId, sessionOptions);
                    res.redirect('/security?m=Password changed');
                });
            });
        });
    });
};

/**
 * POST
 * Restricted API
 * Change the user's password with new UI
**/
exports.newResetPassword = function(req, res, next) {
    var user = req.user;
    assert(user);
    var password = lib.removeNullsAndTrim(req.body.old_password);
    var newPassword = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);
    var confirm = lib.removeNullsAndTrim(req.body.confirmation);
    var ipAddress = req.ip;
    var userAgent = req.get('user-agent');
    if (!password) {
        res.status(500).send('Enter your password');
        return;
    }

    var notValid = lib.isInvalidPassword(newPassword);
    if (notValid) {
        res.status(500).send('New password not valid');
        return;
    }

    if (newPassword !== confirm) {
        res.status(500).send('New password and confirmation should be the same');
        return;
    }

    database.validateUser(user.username, password, otp, function(err, userId) {
        if (err) {
            if (err  === 'WRONG_PASSWORD') return  res.status(500).send('Wrong password');;
            if (err === 'INVALID_OTP') return res.status(500).send('Invalid One Time Password');
            //Should be an user here
            return next(new Error('Unable to reset password: \n' + err));
        }
        assert(userId === user.id);
        database.changeUserPassword(user.id, newPassword, function(err) {
            if (err)
                return res.status(500).send('Invalid One Time Password');;

            database.expireSessionsByUserId(user.id, function(err) {
                if (err)
                    return res.status(500).send('Unable to delete user sessions for userId: ' + user.id + ': \n' + err);

                database.createSession(user.id, ipAddress, userAgent, false, function(err, sessionId) {
                    if (err)
                        return res.status(500).send('Unable to create session for userid ' + userId +  ':\n' + err);

                    res.cookie('id', sessionId, sessionOptions);
                    res.json({user: user, msg: "password changed"});
                });
            });
        });
    });
};

/**
 * POST
 * Restricted API
 * Adds an email to the account
 **/
exports.editEmail = function(req, res, next) {
    var user  = req.user;
    assert(user);

    var email = lib.removeNullsAndTrim(req.body.email);
    var password = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    //If no email set to null
    if(email.length === 0) {
        email = null;
    } else {
        var notValid = lib.isInvalidEmail(email);
        if (notValid) return res.redirect('/security?err=email invalid because: ' + notValid);
    }

    notValid = lib.isInvalidPassword(password);
    if (notValid) return res.render('/security?err=password not valid because: ' + notValid);

    database.validateUser(user.username, password, otp, function(err, userId) {
        if (err) {
            if (err === 'WRONG_PASSWORD') return res.redirect('/security?err=wrong%20password');
            if (err === 'INVALID_OTP') return res.redirect('/security?err=invalid%20one-time%20password');
            //Should be an user here
            return next(new Error('Unable to validate user adding email: \n' + err));
        }

        database.updateEmail(userId, email, function(err) {
            if (err)
                return next(new Error('Unable to update email: \n' + err));

            res.json({user: user, msg: "password changed"});
        });
    });
};

/**
 * POST
 * Restricted API
 * Adds an email to the account for new UI
**/
exports.newEditEmail = function(req, res, next) {
    var user  = req.user;
    assert(user);

    var email = lib.removeNullsAndTrim(req.body.email);
    var password = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    //If no email set to null
    if(email.length === 0) {
        email = null;
    } else {
        var notValid = lib.isInvalidEmail(email);
        if (notValid) return res.status(500).send('email invalid because: ' + notValid);
    }

    notValid = lib.isInvalidPassword(password);
    if (notValid) return res.status(500).send('password not valid because: ' + notValid);

    database.validateUser(user.username, password, otp, function(err, userId) {
        if (err) {
            if (err === 'WRONG_PASSWORD') return res.status(500).send('wrong password');
            if (err === 'INVALID_OTP') return res.status(500).send('invalid one time password');
            //Should be an user here
            // return next(new Error('Unable to validate user adding email: \n' + err));
            return res.status(500).send('Unable to validate user adding email: \n' + err);
        }

        database.updateEmail(userId, email, function(err) {
            if (err)
                // return next(new Error('Unable to update email: \n' + err));
                return res.status(500).send('Unable to update email: \n' + err);

            res.json({user: user, msg: "Email edited"});
        });
    });
}
/**
 * GET
 * Restricted API
 * Shows the security page of the users account
 **/
exports.security = function(req, res) {
    var user = req.user;
    assert(user);

    if (!user.mfa_secret) {
        user.mfa_potential_secret = speakeasy.generateSecret({ length: 32 }).base32;
        var qrUri = 'otpauth://totp/crash3d:' + user.username + '?secret=' + user.mfa_potential_secret + '&issuer=crash3d';
        user.qr_svg = qr.imageSync(qrUri, { type: 'svg' });
        user.sig = lib.sign(user.username + '|' + user.mfa_potential_secret);
    }

    res.render('security', { user: user });
};

/**
 * GET
 * Restricted API
 * Return security info of the users account for new UI
**/
exports.newSecurity = function(req, res) {
    var user = req.user;
    assert(user);

    if (!user.mfa_secret) {
        user.mfa_potential_secret = speakeasy.generateSecret({ length: 32 }).base32;
        var qrUri = 'otpauth://totp/crash3d:' + user.username + '?secret=' + user.mfa_potential_secret + '&issuer=crash3d';
        user.qr_svg = qr.imageSync(qrUri, { type: 'svg' });
        user.sig = lib.sign(user.username + '|' + user.mfa_potential_secret);
    }

    res.json({user: user});
}

/**
 * POST
 * Restricted API
 * Enables the two factor authentication
 **/
exports.enableMfa = function(req, res, next) {
    var user = req.user;
    assert(user);

    var otp = lib.removeNullsAndTrim(req.body.otp);
    var sig = lib.removeNullsAndTrim(req.body.sig);
    var secret = lib.removeNullsAndTrim(req.body.mfa_potential_secret);

    if (user.mfa_secret) return res.redirect('/security?err=2FA%20is%20already%20enabled');
    if (!otp) return next('Missing otp in enabling mfa');
    if (!sig) return next('Missing sig in enabling mfa');
    if (!secret) return next('Missing secret in enabling mfa');

    if (!lib.validateSignature(user.username + '|' + secret, sig))
        return next('Could not validate sig');

    var expected = speakeasy.totp.verify({ secret: secret, encoding: 'base32', token: otp });
    console.log(expected);

    if (!expected) {
        user.mfa_potential_secret = secret;
        var qrUri = 'otpauth://totp/crash3d:' + user.username + '?secret=' + secret + '&issuer=crash3d';
        user.qr_svg = qr.imageSync(qrUri, {type: 'svg'});
        user.sig = sig;

        return res.render('security', { user: user, warning: 'Invalid 2FA token' });
    }

    database.updateMfa(user.id, secret, function(err) {
        if (err) return next(new Error('Unable to update 2FA status: \n' + err));
        res.redirect('/security?=m=Two-Factor%20Authentication%20Enabled');
    });
};

/**
 * POST
 * Restricted API
 * Enables the two factor authentication for new UI
 **/
exports.newEnableMfa = function(req, res, next) {
    var user = req.user;
    assert(user);

    var otp = lib.removeNullsAndTrim(req.body.otp);
    var sig = lib.removeNullsAndTrim(req.body.sig);
    var secret = lib.removeNullsAndTrim(req.body.mfa_potential_secret);

    if (user.mfa_secret)
        return res.status(500).send('2FA is already enabled');
    if (!otp)
        return res.status(500).send('Missing otp in enabling mfa');
    if (!sig)
        return res.status(500).send('Missing sig in enabling mfa');
    if (!secret)
        return res.status(500).send('Missing secret in enabling mfa');

    if (!lib.validateSignature(user.username + '|' + secret, sig))
        return res.status(500).send('Could not validate sig');

    var expected = speakeasy.totp.verify({ secret: secret, encoding: 'base32', token: otp });
    console.log("--------here------------");
    console.log(expected);

    if (!expected) {
        user.mfa_potential_secret = secret;
        var qrUri = 'otpauth://totp/crash3d:' + user.username + '?secret=' + secret + '&issuer=crash3d';
        user.qr_svg = qr.imageSync(qrUri, {type: 'svg'});
        user.sig = sig;

        return res.status(500).send('Invalid 2FA token' );
    }

    database.updateMfa(user.id, secret, function(err) {
        if (err)
            return res.status(500).send('Unable to update 2FA status');
        // res.redirect('/security?=m=Two-Factor%20Authentication%20Enabled');
        res.json({user: user, msg: "Enabled 2FA"});
    });
};

/**
 * POST
 * Restricted API
 * Disables the two factor authentication
 **/
exports.disableMfa = function(req, res, next) {
    var user = req.user;
    assert(user);

    var secret = lib.removeNullsAndTrim(user.mfa_secret);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    if (!secret) return res.redirect('/security?err=Did%20not%20sent%20mfa%20secret');
    if (!user.mfa_secret) return res.redirect('/security?err=2FA%20is%20not%20enabled');
    if (!otp) return res.redirect('/security?err=No%20OTP');

    var expected = speakeasy.totp.verify({ secret: secret, encoding: 'base32', token: otp });
    console.log(expected);
    if (!expected)
        return res.redirect('/security?err=invalid%20one-time%20password');

    database.updateMfa(user.id, null, function(err) {
        if (err) return next(new Error('Error updating Mfa: \n' + err));

        res.redirect('/security?=m=Two-Factor%20Authentication%20Disabled');
    });
};

/**
 * POST
 * Restricted API
 * Disables the two factor authentication
 **/
exports.newDisableMfa = function(req, res, next) {
    var user = req.user;
    assert(user);

    var secret = lib.removeNullsAndTrim(user.mfa_secret);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    if (!secret)
        return res.status(500).send('Did not sent mfa secret');
    if (!user.mfa_secret)
        return res.status(500).send('2FA is not enabled');
    if (!otp)
        return res.status(500).send('No OTP');

    var expected = speakeasy.totp.verify({ secret: secret, encoding: 'base32', token: otp });
    console.log(expected);
    if (!expected)
        return res.status(500).send('Invalid one time password');

    database.updateMfa(user.id, null, function(err) {
        if (err)
            return res.status(500).send('Error updating 2FA');

        // res.redirect('/security?=m=Two-Factor%20Authentication%20Disabled');
        res.json({user: user, msg: "Disabled 2FA"});
    });
};

/**
 * POST
 * Public API
 * Send password recovery to an user if possible
 **/
exports.sendPasswordRecover = function(req, res, next) {
    var email = lib.removeNullsAndTrim(req.body.email);
    if (!email) return res.redirect('forgot-password');
    var remoteIpAddress = req.ip;

    //We don't want to leak if the email has users, so we send this message even if there are no users from that email
    var messageSent = { success: 'We\'ve sent an email to you if there is a recovery email.' };

    database.getUsersFromEmail(email, function(err, users) {
        if(err) {
            if(err === 'NO_USERS')
                return res.render('forgot-password', messageSent);
            else
                return next(new Error('Unable to get users by email ' + email +  ': \n' + err));
        }

        var recoveryList = []; //An array of pairs [username, recoveryId]
        async.each(users, function(user, callback) {

            database.addRecoverId(user.id, remoteIpAddress, function(err, recoveryId) {
                if(err)
                    return callback(err);

                recoveryList.push([user.username, recoveryId]);
                callback(); //async success
            })

        }, function(err) {
            if(err)
                return next(new Error('Unable to add recovery id :\n' + err));

            sendEmail.passwordReset(email, recoveryList, function(err) {
                if(err)
                    return next(new Error('Unable to send password email: \n' + err));

                return res.render('forgot-password',  messageSent);
            });
        });

    });
};

/**
 * GET
 * Public API
 * Validate if the reset id is valid or is has not being uses, does not alters the recovery state
 * Renders the change password
 **/
exports.validateResetPassword = function(req, res, next) {
    var recoverId = req.params.recoverId;
    if (!recoverId || !lib.isUUIDv4(recoverId))
        return next('Invalid recovery id');

    database.getUserByValidRecoverId(recoverId, function(err, user) {
        if (err) {
            if (err === 'NOT_VALID_RECOVER_ID')
                return next('Invalid recovery id');
            return next(new Error('Unable to get user by recover id ' + recoverId + '\n' + err));
        }
        res.render('reset-password', { user: user, recoverId: recoverId });
    });
};

/**
 * POST
 * Public API
 * Receives the new password for the recovery and change it
 **/
exports.resetPasswordRecovery = function(req, res, next) {
    var recoverId = req.body.recover_id;
    var password = lib.removeNullsAndTrim(req.body.password);
    var ipAddress = req.ip;
    var userAgent = req.get('user-agent');

    if (!recoverId || !lib.isUUIDv4(recoverId)) return next('Invalid recovery id');

    var notValid = lib.isInvalidPassword(password);
    if (notValid) return res.render('reset-password', { recoverId: recoverId, warning: 'password not valid because: ' + notValid });

    database.changePasswordFromRecoverId(recoverId, password, function(err, user) {
        if (err) {
            if (err === 'NOT_VALID_RECOVER_ID')
                return next('Invalid recovery id');
            return next(new Error('Unable to change password for recoverId ' + recoverId + ', password: ' + password + '\n' + err));
        }
        database.createSession(user.id, ipAddress, userAgent, false, function(err, sessionId) {
            if (err)
                return next(new Error('Unable to create session for password from recover id: \n' + err));

            res.cookie('id', sessionId, sessionOptions);
            res.redirect('/');
        });
    });
};

/**
 * GET
 * Restricted API
 * Shows the deposit history
 **/
exports.deposit = function(req, res, next) {
    var user = req.user;
    assert(user);

    database.getDeposits(user.id, function(err, deposits) {
        if (err) {
            return next(new Error('Unable to get deposits: \n' + err));
        }
        user.deposits = deposits;
        wallet.getWallet(user, function(error, result){
            console.log("get wallet result:", error, result);
            user.deposit_address = result;
            res.render('account', { user: user });
        });
    });
};


 /**
  * GET
  * Restricted API
  * Shows the transfer history
  **/
exports.transfer = function(req, res, next) {
  var user = req.user;
  assert(user);

  var success = (req.query.m === 'success') ? 'Transfer has been made' : undefined;


  database.getTransfers(user.id, function(err, transfers) {
      if (err)
          return next(new Error('Unable to get transfers: ' + err));

      res.render('transfer', { user: user, transfers: transfers, success: success });
  });
};

exports.transferJson = function(req, res, next) {
    var user = req.user;
    assert(user);


    database.getTransfers(user.id, function(err, transfers) {
        if (err)
            return next(new Error('Unable to get transfers: ' + err));

        res.json(transfers);
    });
};

  /**
   * GET
   * Restricted API
   * Shows the transfer request page
   **/

exports.transferRequest = function(req, res) {
    assert(req.user);
    res.render('transfer-request', { user: req.user, id: uuid.v4() });
};


 /**
  * GET
  * Restricted API
  * Process a transfer (tip)
  **/

 exports.handleTransferRequest = function (req,res,next){
     var user = req.user;
     assert(user);
     var uid = req.body['transfer-id'];
     var amount = lib.removeNullsAndTrim(req.body.amount);
     var toUserName = lib.removeNullsAndTrim(req.body['to-user']);
     var password = lib.removeNullsAndTrim(req.body.password);
     var otp = lib.removeNullsAndTrim(req.body.otp);
     var r =  /^[1-9]\d*(\.\d{0,2})?$/;
     if (!r.test(amount))
         return res.render('transfer-request', { user: user, id: uuid.v4(),  warning: 'Not a valid amount' });
    amount = Math.round(parseFloat(amount) * 100);

     if (amount < 10000)
        return res.render('transfer-request', { user: user, id: uuid.v4(),  warning: 'Must transfer at least 100 bits' });

    if (!password)
        return res.render('transfer-request', { user: user,  id: uuid.v4(), warning: 'Must enter a password'});

    if (user.username.toLowerCase() === toUserName.toLowerCase()) {
        return res.render('transfer-request', { user: user,  id: uuid.v4(), warning: 'Can\'t send money to yourself'});
    }

    database.validateUser(user.username, password, otp, function(err) {

        if (err) {
            if (err === 'WRONG_PASSWORD')
                return res.render('transfer-request', {
                    user: user,
                    id: uuid.v4(),
                    warning: 'wrong password, try it again...'
                });
            if (err === 'INVALID_OTP')
                return res.render('transfer-request', {user: user, id: uuid.v4(), warning: 'invalid one-time token'});
            //Should be an user
            return next(new Error('Unable to validate user handling transfer: ' + err));
        }
        // Check destination user

        database.makeTransfer(uid, user.id, toUserName, amount, function (err) {
            if (err) {
                if (err === 'NOT_ENOUGH_BALANCE')
                    return res.render('transfer-request', {user: user, id: uuid.v4(), warning: 'Not enough balance for transfer'});
                if (err === 'USER_NOT_EXIST')
                    return res.render('transfer-request', {user: user, id: uuid.v4(), warning: 'Could not find user'});
                if (err === 'TRANSFER_ALREADY_MADE')
                    return res.render('transfer-request', {user: user, id: uuid.v4(), warning: 'You already submitted this'});

                console.error('[INTERNAL_ERROR] could not make transfer: ', err);
                return res.render('transfer-request', {user: user, id: uuid.v4(), warning: 'Could not make transfer'});
            }

            return res.redirect('/transfer?m=success');
        });
    });

 };

/**
 * GET
 * Restricted API
 * Shows the withdrawal history
 **/
exports.withdraw = function(req, res, next) {
    var user = req.user;
    assert(user);

    database.getWithdrawals(user.id, function(err, withdrawals) {
        if (err)
            return next(new Error('Unable to get withdrawals: \n' + err));

        withdrawals.forEach(function(withdrawal) {
            withdrawal.shortDestination = withdrawal.destination.substring(0,8);
        });
        user.withdrawals = withdrawals;

        res.render('withdraw', { user: user });
    });
};

/**
 * POST
 * Restricted API
 * Process a withdrawal
 **/
exports.handleWithdrawRequest = function(req, res, next) {
    var user = req.user;
    assert(user);

    var amount = lib.removeNullsAndTrim(req.body.amount);
    var destination = lib.removeNullsAndTrim(req.body.destination);
    var withdrawalId = lib.removeNullsAndTrim(req.body.withdrawal_id);
    var password = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    var r =  /^[1-9]\d*(\.\d{0,2})?$/;
    if (!r.test(amount))
        return res.render('withdraw-request', { user: user, id: uuid.v4(),  warning: 'Not a valid amount' });

    amount = Math.round(parseFloat(amount) * 100);
    assert(Number.isFinite(amount));

    var minWithdraw = config.MINING_FEE + 10000;

    if (amount < minWithdraw)
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'You must withdraw ' + minWithdraw + ' or more'  });

    if (typeof destination !== 'string')
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Destination address not provided' });

    // try {
    //     // var version = bitcoinjs.address.fromBase58Check(destination).version;
    //     // if (version !== bitcoinjs.networks.bitcoin.pubKeyHash && version !== bitcoinjs.networks.bitcoin.scriptHash)
    //         return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Destination address is not a bitcoin one' });
    // } catch(ex) {
    //     return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Not a valid destination address' });
    // }

    if (!password)
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Must enter a password' });

    if(!lib.isUUIDv4(withdrawalId))
      return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Could not find a one-time token' });

    database.validateUser(user.username, password, otp, function(err) {

        if (err) {
            if (err === 'WRONG_PASSWORD')
                return res.render('withdraw-request', { user: user, id: uuid.v4(), warning: 'wrong password, try it again...' });
            if (err === 'INVALID_OTP')
                return res.render('withdraw-request', { user: user, id: uuid.v4(), warning: 'invalid one-time token' });
            //Should be an user
            return next(new Error('Unable to validate user handling withdrawal: \n' + err));
        }

        // withdraw(req.user.id, amount, destination, withdrawalId, function(err) {
        wallet.withdraw(req.user.id, amount, destination, withdrawalId, function(err) {
            if (err) {
                if (err === 'NOT_ENOUGH_MONEY')
                    return res.render('withdraw-request', { user: user, id: uuid.v4(), warning: 'Not enough money to process withdraw.' });
                else if (err === 'PENDING')
                    return res.render('withdraw-request', { user: user,  id: uuid.v4(), success: 'Withdrawal successful, however hot wallet was empty. Withdrawal will be reviewed and sent ASAP' });
                else if(err === 'SAME_WITHDRAWAL_ID')
                    return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Please reload your page, it looks like you tried to make the same transaction twice.' });
                else if(err === 'FUNDING_QUEUED')
                    return res.render('withdraw-request', { user: user,  id: uuid.v4(), success: 'Your transaction is being processed come back later to see the status.' });
                else
                    return next(new Error('Unable to withdraw: ' + err));
            }
            return res.render('withdraw-request', { user: user, id: uuid.v4(), success: 'OK' });
        });
    });
};

exports.handleWithdrawRequestAJAX = function(req, res, next) {
    var user = req.user;
    assert(user);

    var amount = lib.removeNullsAndTrim(req.body.amount);
    var destination = lib.removeNullsAndTrim(req.body.destination);
    var withdrawalId = uuid.v4();
    var password = lib.removeNullsAndTrim(req.body.password);
    var otp = lib.removeNullsAndTrim(req.body.otp);

    var r =  /^\d+(\.\d{0,4})?$/;
    if (!r.test(amount))
        return res.render('withdraw-request', { user: user, id: uuid.v4(),  warning: 'Not a valid amount' });

    gwei = parseFloat(amount) * 1e6;
    assert(Number.isFinite(gwei));
    // assert(Number.isFinite(gwei / config.MINIMUM_WITHDRAW));
    // satoshis = Math.round(satoshis / config.MINIMUM_WITHDRAW) * config.MINIMUM_WITHDRAW;

    if (amount < config.MINIMUM_WITHDRAW)
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'You must withdraw ' + minWithdraw + ' or more'  });

    if (typeof destination !== 'string')
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Destination address not provided' });

    if (!password)
        return res.render('withdraw-request', { user: user,  id: uuid.v4(), warning: 'Must enter a password' });

    database.validateUser(user.username, password, otp, function(err) {

        if (err) {
            if (err === 'WRONG_PASSWORD')
                return res.render('withdraw-request', { user: user, id: uuid.v4(), warning: 'wrong password, try it again...' });
            if (err === 'INVALID_OTP')
                return res.render('withdraw-request', { user: user, id: uuid.v4(), warning: 'invalid one-time token' });
            //Should be an user
            return next(new Error('Unable to validate user handling withdrawal: \n' + err));
        }

        withdraw(req.user.id, gwei, destination, withdrawalId, function(err) {
            if (err) {
                if (err === 'NOT_ENOUGH_MONEY')
                    return res.json({ user: user, id: uuid.v4(), warning: 'Not enough money to process withdraw.' });
                else if (err === 'PENDING')
                    return res.json({ user: user,  id: uuid.v4(), success: 'Withdrawal successful, however hot wallet was empty. Withdrawal will be reviewed and sent ASAP' });
                else if(err === 'SAME_WITHDRAWAL_ID')
                    return res.json({ user: user,  id: uuid.v4(), warning: 'Please reload your page, it looks like you tried to make the same transaction twice.' });
                else if(err === 'FUNDING_QUEUED')
                    return res.json({ user: user,  id: uuid.v4(), success: 'Your transaction is being processed come back later to see the status.' });
                else
                    return res.json({ user: user,  id: uuid.v4(), error: 'Unable to withdraw' });
            }
            return res.json({ user: user, id: uuid.v4(), success: 'OK' });
        });
    });
};

/**
 * GET
 * Restricted API
 * Shows the withdrawal request page
 **/
exports.withdrawRequest = function(req, res) {
    assert(req.user);
    res.render('withdraw-request', { user: req.user, id: uuid.v4() });
};

exports.withdrawRequestAJAX = function(req, res) {
    assert(req.user);
    res.json({ user: req.user, id: uuid.v4() });
};

/**
 * GET
 * Restricted API
 * Shows the support page
 **/
exports.contact = function(req, res) {
    assert(req.user);
    res.render('support', { user: req.user })
};

/**
 * GET
 * Public API
 * Returns an array of usernames or null
 **/
exports.getUsernamesByPrefix = function(req, res, next) {
    var prefix = req.params.prefix;

    //Validate prefix
    if(lib.isInvalidUsername(prefix))
        return res.status(400).send('INVALID_PREFIX');

    database.getUsernamesByPrefix(prefix, function(err, usernames) {
        if(err) {
            console.error('[INTERNAL_ERROR] unable to request usernames by prefix: ', usernames);
            return res.status(500).send('INTERNAL_ERROR');
        }

        res.send(JSON.stringify(usernames));
    })
};
