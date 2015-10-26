var mapLoader = require('./map'),
    moment = require('moment'),
    stateLoader = require('./state'),
    util = require('./util');

module.exports = main;

function main(outputPath) {
    var startTime = moment();
    util.log('Started.');

    var state = stateLoader.load(outputPath);
    logPlayersState(state);

    var map = mapLoader.load(outputPath);
    logMap(map);
    var move = 'Nothing';
    if (state.RoundNumber != 0) {
        if (state.Players[0].Ship) {
            var radar = senseDanger(state);
            var targetWaveFront = buildTargettingWavefront(state);
            var hordeMoments = buildHordeMoments(state, (state.Players[0].PlayerNumberReal == 2));
            var activeMissleTrajectories = [];
            for (var i = 0; i < state.Players[0].Missiles.length; i++) {
                activeMissleTrajectories.push(buildMissleMoments(state.Players[0].Missiles[i].X, state.Players[0].Missiles[i].Y));
            }
            var validTargets = findBestTargets(targetWaveFront, hordeMoments, activeMissleTrajectories);
            move = getNewMove(state, validTargets, radar);
            logTargettingState(state.Players[0], validTargets);
        }
        else {
            debugLogString('Respawning...');
        }
    }
    else {
        move = 'Shoot';
    }
    
    util.outputMove(move, outputPath, function() {
        var endTime = moment();
        var runTime = endTime.diff(startTime);
        util.log('Finished in ' + runTime + 'ms.');
    });
}

function logPlayersState(state) {
    if (state === null) {
        util.logError('Failed to load state.');
        return;
    }

    util.log('Game state:')
    util.log('\tRound: ', state.RoundNumber);

    for (var i = 0; i < state.Players.length; i++) {
        logPlayerState(state.Players[i]);
    }
}

function logPlayerState(player) {
    var playerName = '\tPlayer ' + player.PlayerNumberReal + ' (' + player.PlayerName + ')';

    util.log(playerName, '\tKills:', player.Kills);
    util.log(playerName, '\tLives: ', player.Lives);
    util.log(playerName, '\tMissiles:', player.Missiles.length, '/', player.MissileLimit);
}

function logMap(map) {
    if (map === null) {
        util.logError('Failed to load map.');
    }

    util.log('Map:\n' + map.text);
}

function getNewMove(state, validTargets, radar) {
    var move = 'Nothing';
    if (state.RoundNumber == 0) {
        debugLogString('First blood!');
        // if you shoot right at the start, you hit one alien.
        return 'Shoot';
    }
    // lets not be too hasty on the shooting just yet
    //for (var i = 0; i < validTargets.length; i++) {
    //    if (validTargets[i].nextMove == 'Shoot') {
    //        return 'Shoot';
    //    }
    //}
    //debugLogString('I have no target or cannot shoot safely');
    //  No - Do I have lives and no missle factory?
    if (DoIHaveLivesAndNoAlienFactory(state)) {
        debugLogString('I do not have an AF');
        // Yes - Am I in positoin for the alien factory?
        if (state.Players[0].Ship.X == 2) {
            debugLogString('In position - building AF');
            // Yes -  Build the alien factory
            move = 'BuildAlienFactory';
        }
        else {
            debugLogString('Not in position to build AF');
            // No - Will I get hit going left?
            if (!willIGetHitIfI(state, radar, 'MoveLeft')) {
                debugLogString('It is safe to move Left');
                // No - Go left (to build the alien factory)
                move = 'MoveLeft';
            }
            else {
                // Yes - Dodge (or pause?)
                debugLogString('It is NOT safe to move left - dodge!');
                move = DodgeLeftRight(state, 'MoveLeft', radar);
            }
        }
    }
    else if (DoIHaveLivesAndNoMissleFactory(state)) {
        debugLogString('I do not have a MF');
        // Yes - Am I in position for the factory?
        if (state.Players[0].Ship.X == 14) {
            // Yes - Build Factory
            debugLogString('In position - building MF');
            move = 'BuildMissileController';
        }
        else {
            debugLogString('Not in position to build MF');
            // No - Will I get hit going right?
            if (!willIGetHitIfI(state, radar, 'MoveRight')) {
                debugLogString('Its Safe to move Right');
                // No - Go right (to build the factory)
                move = 'MoveRight';
            }
            else {
                // Yes - Dodge (or pause?)
                debugLogString('Its Not Safe to move Right - dodge!');
                move = DodgeLeftRight(state, 'MoveRight', radar);
            }
        }
    }
    else {
        debugLogString('I have both factories/not enough lives to build or no target');
        // find the safe target with the lowest weight and do that.
        var bestTarget = { targetWeight: 0, nextMove: 'Nothing' };
        var ammoLeft = (state.Players[0].Missiles.length != state.Players[0].MissileLimit);
        for (var i = 0; i < validTargets.length; i++) {
            if (ammoLeft) {
                if (validTargets[i].targetWeight > bestTarget.targetWeight) {
                    bestTarget = validTargets[i];
                }
            }
            else {
                if ((validTargets[i].targetWeight > bestTarget.targetWeight) && (validTargets[i].nextMove != 'Shoot')) {
                    bestTarget = validTargets[i];
                }
            }
        }
        move = bestTarget.nextMove;
        debugLogString('My best bet is to shoot Alien @ X: '+bestTarget.alienOriginX +' Y:'+ bestTarget.alienOriginY+' move:'+bestTarget.nextMove+' toHit:'+bestTarget.momentsInFuture);
        // in case this was actually the default above, make sure its safe
        if (!willIGetHitIfI(state, radar, move)) {
            move = move;
        }
        else {
            move = DodgeLeftRight(state, move, radar);
        }
    }
    return move;
}

function checkForEnemyMissile(sensedObject){
    if (sensedObject) {
        var enemyPlayerNumber = 2; // in case I need to pass in to check against ACTUAL player number
        return ((sensedObject.Type == 'Missile') && (sensedObject.PlayerNumber == enemyPlayerNumber)) || (sensedObject.Type == 'Bullet');
    }
    else {
        return false;
    }
}

function checkForObstacle(sensedObject){
    if (sensedObject) {
        return (checkForEnemyMissile(sensedObject) || (sensedObject.Type == 'Shield'));
    }
    else {
        return false;
    }
}


function senseDanger(state) {
    // you are in trouble if:
    // CLose range - immediate danger
    // 19       . . . . . . . M - middle - you are dead
    // 20       . . . . . . . L - left wing - you are dead
    // 21       . P L M R P . R - right wing - you are dead
    // 22       . . A A A . . P - Periphery, left or right, You can't move in this direction it kills you
    
    // Medium range - danger
    // 19       . . . . . . . M - middle - shoot
    // 20       . B L M R B . L - left wing - dodge right
    // 21       . . . . . . . R - right wing - dodge left
    // 22       . . A A A . . B - blind spot - moving there will kill you
    //                        
    
    // Long range - Warning
    // 19       B P L M R P B M - middle - moving twice will dodge this completely
    // 20       . . . . . . . L - Left wing - if goign left, then move left once and shoot (if you have a missle)
    // 21       . . . . . . . R - Right wing - same as left
    // 22       . . A A A . . P - Moving left kills you
    //                        B - moving in that direction will kill you if you keep moving.
    
    var radarResponse = {Close: {PL:false, L:false, M:false, R:false, PR:false}, Medium: { BL:false, L: false, M: false, R: false, BR: false}, Long: { BL: false, PL:false, L: false, M: false, R: false, PR:false, BR: false}}
    radarResponse.Close.PL = checkForEnemyMissile(state.Map.Rows[21][state.Players[0].Ship.X - 1]);
    radarResponse.Close.L = checkForEnemyMissile(state.Map.Rows[21][state.Players[0].Ship.X]);
    radarResponse.Close.M = checkForEnemyMissile(state.Map.Rows[21][state.Players[0].Ship.X + 1]);
    radarResponse.Close.R = checkForEnemyMissile(state.Map.Rows[21][state.Players[0].Ship.X + 2]);
    radarResponse.Close.PR = checkForEnemyMissile(state.Map.Rows[21][state.Players[0].Ship.X + 3]);

    radarResponse.Medium.BL = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X - 1]);
    radarResponse.Medium.L = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X]);
    radarResponse.Medium.M = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X + 1]);
    radarResponse.Medium.R = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X + 2]);
    radarResponse.Medium.BR = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X + 3]);
    
    radarResponse.Long.BL = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X - 2]);
    radarResponse.Long.PL = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X - 1]);
    radarResponse.Long.L = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X]);
    radarResponse.Long.M = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X + 1]);
    radarResponse.Long.R = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X + 2]);
    radarResponse.Long.PR = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X + 3]);
    radarResponse.Long.BR = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X + 4]);
    
    return radarResponse;
}

function willIGetHitIfI(state, radar, proposal) {
    // input the move you want to do - shoot, go left, go right
    if (proposal == 'Shoot') {
        // if you have a missle on either wing, you can't shoot, you will die, otherwise you should be ok
        return (radar.Medium.L || radar.Medium.R);
    }
    else if (proposal == 'Nothing') {
        // if you just want to wait, you can't have anything in front of you
        return (radar.Medium.L || radar.Medium.M || radar.Medium.R);
    }
    else if (proposal == 'MoveLeft') {
        // if you are moving left, you can't move if you have somethign on your wing, or the blindspot/periphery
        // you can move left and shoot if its in the periphery though
        return (radar.Close.PL || radar.Medium.BL || radar.Medium.L || radar.Medium.M || radar.Long.PL);
    }
    else if (proposal == 'MoveRight') {
        // if you are moving left, you can't move if you have somethign on your wing, or the blindspot/periphery
        // you can move left and shoot if its in the periphery 
        return (radar.Close.PR || radar.Medium.M || radar.Medium.R || radar.Medium.BR || radar.Long.PR);
    }
    else if (proposal == 'BuildMissileController') {
        // building is much like shooting, only you can't manage to kill a missle
        return (radar.Medium.L || radar.Medium.M ||radar.Medium.R );
    }
    else if (proposal == 'BuildAlienFactory') {
        // building is much like shooting, only you can't manage to kill a missle
        return (radar.Medium.L || radar.Medium.M || radar.Medium.R);
    }
    return false;
}

function DodgeLeftRight(state, proposal, radar){
    // hopefully you have a missle left if you managed to get here
    if (radar.Medium.M) {
        // if you have ALREADY attempted to shoot it, I gues you are ok...
        return 'Shoot'; // or you die.
    }
    if (radar.Medium.L) {
        // hope for the best
        return 'MoveRight';
    }
    if (radar.Medium.R) {
        // hope for the best
        return 'MoveLeft';
    }
    if (radar.Close.PL && radar.Close.PR) {
        // both blind spots running - hide in the middle
        return 'Nothing';
    }
    if (radar.Medium.BL && radar.Medium.BR) {
        // both blind spots running - hide in the middle
        return 'Nothing';
    }
    if (proposal == 'MoveLeft' && (radar.Medium.BL)) {
        // you were stopped from moving into a dead blind spot. Can you just wait for it to pass? only if totally clear!
        if (!(radar.Medium.L || radar.Medium.M || radar.Medium.R || radar.Long.L || radar.Long.M || radar.Long.R)) {
            return 'Nothing';
        }
        else {
            // if there was just one long range threat - shoot it. 
            if ((radar.Long.M) && (!(radar.Medium.L || radar.Medium.M || radar.Medium.R || radar.Long.L || radar.Long.R)))
                if (state.Players[0].Missiles.length != state.Players[0].MissileLimit)
                    return 'Shoot';
                else
                    return 'MoveRight';
            else
                // ok, you are blocked at a blind spot, and you can't wait it out - go right.
                return 'MoveRight';
        }
    }
    if (proposal == 'MoveRight' && (radar.Medium.BR)) {
        // you were stopped from moving into a dead blind spot. Can you just wait for it to pass? only if totally clear!
        if (!(radar.Medium.L || radar.Medium.M || radar.Medium.R || radar.Long.L || radar.Long.M || radar.Long.R)) {
            return 'Nothing';
        }
        else {
            // if there was just one long range threat - shoot it. 
            if ((radar.Long.M) && (!(radar.Medium.L || radar.Medium.M || radar.Medium.R || radar.Long.L || radar.Long.R))) {
                if (state.Players[0].Missiles.length != state.Players[0].MissileLimit)
                    return 'Shoot';
                else
                    return 'MoveLeft';
            }
            else {
                // ok, you are blocked at a blind spot, and you can't wait it out - go right.
                return 'MoveLeft';
            }
        }
    }
    // am I missing something?   
}

function targettingBulletRadarCone(state){
//This, the cone of bullet danger means that if abullet is in one of those positions, then the moment associated with that
//position is not a valid option.Ie.to shoot here, there can 't be a bullet in 1, to shoot from the left or righht
//there can 't be a bullet in the 1 associated with that direction, OR the 2.
//5. . . . . . . . . 5
//. 4 . . . . . . . 4 . etc.
//. . 3 . . . . . 3 . . move left/right 3 times
//. . . 2 . P . 2 . . . move left/right twice
//. . . . 1 . 1 . . . . move left/right once
//. . . . . . . . . . . if you try and pause with a missle at P you are buggered
//. . . . A A A . . . .
    
// bullets at blocking points will not kill the player, but will block missles.
//. L L L L M R R R R .
//. . L L L M R R R . . 
//. . . L L M R R . . . etc.
//. . . . L M R . . . . moving L/R and firing means you will hit the bullet eventually
//. . . . . M . . . . . firing now means the bullet will hit the missle (though, you want this).
//. . . . . . . . . . .
//. . . . A A A . . . .
    
    var TargettingBullets = { P:false, L1: false, L2: false, L3: false, L4: false, L5: false, L6: false, R1: false, R2: false, R3: false, R4: false, R5: false, R6: false };
    var blockingBullets = { M: false, L1: false, L2: false, L3: false, L4: false, R1: false, R2: false, R3: false, R4: false };
    //check for overruns on the array
    TargettingBullets.P = checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X+1]);
    TargettingBullets.L1 = checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X]);
    TargettingBullets.L2 = ((state.Players[0].Ship.X - 1) > 0)?(checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X-1])):(false);
    TargettingBullets.L3 = ((state.Players[0].Ship.X - 2) > 0)?(checkForEnemyMissile(state.Map.Rows[18][state.Players[0].Ship.X-2])):(false);
    TargettingBullets.L4 = ((state.Players[0].Ship.X - 3) > 0)?(checkForEnemyMissile(state.Map.Rows[17][state.Players[0].Ship.X-3])):(false);
    TargettingBullets.L5 = ((state.Players[0].Ship.X - 4) > 0)?(checkForEnemyMissile(state.Map.Rows[16][state.Players[0].Ship.X-4])):(false);
    TargettingBullets.L6 = ((state.Players[0].Ship.X - 5) > 0)?(checkForEnemyMissile(state.Map.Rows[15][state.Players[0].Ship.X-5])):(false);
    TargettingBullets.R1 = ((state.Players[0].Ship.X + 2) < 18)?(checkForEnemyMissile(state.Map.Rows[20][state.Players[0].Ship.X + 2])):(false);
    TargettingBullets.R2 = ((state.Players[0].Ship.X + 3) < 18)?(checkForEnemyMissile(state.Map.Rows[19][state.Players[0].Ship.X+3])):(false);
    TargettingBullets.R3 = ((state.Players[0].Ship.X + 4) < 18)?(checkForEnemyMissile(state.Map.Rows[18][state.Players[0].Ship.X+4])):(false);
    TargettingBullets.R4 = ((state.Players[0].Ship.X + 5) < 18)?(checkForEnemyMissile(state.Map.Rows[17][state.Players[0].Ship.X+5])):(false);
    TargettingBullets.R5 = ((state.Players[0].Ship.X + 6) < 18)?(checkForEnemyMissile(state.Map.Rows[16][state.Players[0].Ship.X+6])):(false);
    TargettingBullets.R6 = ((state.Players[0].Ship.X + 7) < 18)?(checkForEnemyMissile(state.Map.Rows[15][state.Players[0].Ship.X+7])):(false);
    
    // unrolled the loop for speed - so many positions to look at!
    blockingBullets.M = checkForObstacle(state.Map.Rows[21][state.Players[0].Ship.X + 1]) || checkForObstacle(state.Map.Rows[20][state.Players[0].Ship.X + 1]) || checkForObstacle(state.Map.Rows[19][state.Players[0].Ship.X + 1])|| checkForObstacle(state.Map.Rows[18][state.Players[0].Ship.X + 1])|| checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X + 1])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X + 1]);
    blockingBullets.L1 = checkForObstacle(state.Map.Rows[19][state.Players[0].Ship.X]) || checkForObstacle(state.Map.Rows[18][state.Players[0].Ship.X])|| checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X]);
    blockingBullets.L2 = ((state.Players[0].Ship.X - 1) > 0)?(checkForObstacle(state.Map.Rows[18][state.Players[0].Ship.X - 1])|| checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X - 1])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X - 1])):(false);
    blockingBullets.L3 = ((state.Players[0].Ship.X - 2) > 0)?(checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X - 2])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X - 2])):(false);
    blockingBullets.L4 = ((state.Players[0].Ship.X - 3) > 0)?(checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X - 3])):(false);
    blockingBullets.R1 = ((state.Players[0].Ship.X + 2) < 18)?(checkForObstacle(state.Map.Rows[19][state.Players[0].Ship.X + 2])|| checkForObstacle(state.Map.Rows[18][state.Players[0].Ship.X + 2])|| checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X + 2])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X + 2])):(false);
    blockingBullets.R2 = ((state.Players[0].Ship.X + 3) < 18)?(checkForObstacle(state.Map.Rows[18][state.Players[0].Ship.X + 3])|| checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X + 3])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X + 3])):(false);
    blockingBullets.R3 = ((state.Players[0].Ship.X + 4) < 18)?(checkForObstacle(state.Map.Rows[17][state.Players[0].Ship.X + 4])|| checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X + 4])):(false);
    blockingBullets.R4 = ((state.Players[0].Ship.X + 5) < 18)?(checkForObstacle(state.Map.Rows[16][state.Players[0].Ship.X + 5])):(false);
    return { targettingMe: TargettingBullets, blockingMe: blockingBullets };
}

function buildTargettingWavefront(state){
//  wavefront algorithm - I am here, if Ishoot now, this is where my missle will be in moments.
//. 0 9 8 7 6 7 8 9 0 . I shoot now, in moment 1 its in front of me
//. 9 8 7 6 5 6 7 8 9 .	in moment 2, its 1 ahead, etc     
//. 8 7 6 5 4 5 6 7 8 .	or I move left, but then its one moment later, and then fire
//. 7 6 5 4 3 4 5 6 7 .
//. 6 5 4 3 2 3 4 5 6 . for this to work tho, there can't be a bullet in the wrong spot
//. 5 4 3 2 1 2 3 4 5 .
//. . . . A A A . . . .
    var targetRadar = targettingBulletRadarCone(state);
    var shipX = state.Players[0].Ship.X;
    var shipY = 22;

    // how to get to the spot to fire.
    function targetMoment(left, right, X, Y, targeted, blocking, pause){
        var pauseInput = pause || false;
        return { moveLeft: left,moveRight:right,x: X, y: Y, inValid: targeted, blocked:blocking, pausing: pauseInput};
    }
    
    function generateTargetMoments(targetRadar, currentShipX, momentsInTheFuture) {
        var targetMoments = [];
        // generate one for every position you can go left, assuming you are not blocked by a wall
        var leftPositions = ((currentShipX - 1) < (momentsInTheFuture - 1))?(currentShipX - 1):(momentsInTheFuture - 1);
        // (15 - currentShipX) is the max you can move right.
        var rightPositions = ((15 - currentShipX) < (momentsInTheFuture - 1))?(15 - currentShipX):(momentsInTheFuture - 1);
        // first do the shoot and pause for shoots
        targetMoments.push(new targetMoment(0, 0, (currentShipX + 1), (shipY - momentsInTheFuture), (targetRadar.targettingMe.L1 || targetRadar.targettingMe.R1), targetRadar.blockingMe.M));
        if (momentsInTheFuture != 1) {
            targetMoments.push(new targetMoment(0, 0, (currentShipX + 1), (shipY - momentsInTheFuture + 1), (targetRadar.targettingMe.L1 || targetRadar.targettingMe.R1 || targetRadar.targettingMe.P), targetRadar.blockingMe.M, true));
        }
        // generate the left hand side.
        for (var i = 0; i < leftPositions; i++) {
            // if you move left once, you will be targeted by L1 and L2
            var targettingMe = (targetRadar.targettingMe.L1 || targetRadar.targettingMe.L2);
            // every additional point you move on, you will be targeted again.
            targettingMe = (i > 0)?(targettingMe || targetRadar.targettingMe.L3):(targettingMe);
            targettingMe = (i > 1)?(targettingMe || targetRadar.targettingMe.L4):(targettingMe);
            targettingMe = (i > 2)?(targettingMe || targetRadar.targettingMe.L5):(targettingMe);
            targettingMe = (i > 3)?(targettingMe || targetRadar.targettingMe.L6):(targettingMe);
            var blockingLine = false;
            blockingLine = (i == 0)?(blockingLine || targetRadar.blockingMe.L1):(blockingLine);
            blockingLine = (i == 1)?(blockingLine || targetRadar.blockingMe.L2):(blockingLine);
            blockingLine = (i == 2)?(blockingLine || targetRadar.blockingMe.L3):(blockingLine);
            blockingLine = (i == 3)?(blockingLine || targetRadar.blockingMe.L4):(blockingLine);
            targetMoments.push(new targetMoment((i + 1), 0, (currentShipX - i), (22 - (momentsInTheFuture - 1 - i)), targettingMe, blockingLine));
            // there is one more unpaused position than paused. Don't add the furthest one.
            if (i != (leftPositions - 1)) {
                targetMoments.push(new targetMoment((i + 1), 0, (currentShipX - i), (22 - (momentsInTheFuture - i)), targettingMe, blockingLine, true));
            }
        }
        for (var i = 0; i < rightPositions; i++) {
            // if you move right once, you will be targeted by R1 and R2
            var targettingMe = (targetRadar.targettingMe.R1 || targetRadar.targettingMe.R2);
            // every additional point you move on, you will be targeted again.
            targettingMe = (i > 0)?(targettingMe || targetRadar.targettingMe.R3):(targettingMe);
            targettingMe = (i > 1)?(targettingMe || targetRadar.targettingMe.R4):(targettingMe);
            targettingMe = (i > 2)?(targettingMe || targetRadar.targettingMe.R5):(targettingMe);
            targettingMe = (i > 3)?(targettingMe || targetRadar.targettingMe.R6):(targettingMe);
            var blockingLine = false;
            blockingLine = (i == 0)?(blockingLine || targetRadar.blockingMe.R1):(blockingLine);
            blockingLine = (i == 1)?(blockingLine || targetRadar.blockingMe.R2):(blockingLine);
            blockingLine = (i == 2)?(blockingLine || targetRadar.blockingMe.R3):(blockingLine);
            blockingLine = (i == 3)?(blockingLine || targetRadar.blockingMe.R4):(blockingLine);
            targetMoments.push(new targetMoment(0, (i + 1), (currentShipX + 2 + i), (22 - (momentsInTheFuture - 1 - i)), targettingMe, blockingLine));
            // there is one more unpaused position than paused. Don't add the furthest one.
            if (i != (leftPositions - 1)) {
                targetMoments.push(new targetMoment(0, (i + 1), (currentShipX + 2 + i), (22 - (momentsInTheFuture - i)), (targettingMe || targetRadar.targettingMe.P), blockingLine, true));
            }
        }
        return targetMoments;
    }
    
    var waveTargetMoments = {
        moment1: [], 
        moment2: [], 
        moment3: [], 
        moment4: [], 
        moment5: [], 
        moment6: [], 
        moment7: [], 
        moment8: [], 
        moment9: [], 
        moment10: [], 
        moment11: [], 
        moment12: [], 
        moment13: [],
    };
    
    waveTargetMoments.moment1 = generateTargetMoments(targetRadar, shipX, 1);
    waveTargetMoments.moment2 = generateTargetMoments(targetRadar, shipX, 2);
    waveTargetMoments.moment3 = generateTargetMoments(targetRadar, shipX, 3);
    waveTargetMoments.moment4 = generateTargetMoments(targetRadar, shipX, 4);
    waveTargetMoments.moment5 = generateTargetMoments(targetRadar, shipX, 5);
    waveTargetMoments.moment6 = generateTargetMoments(targetRadar, shipX, 6);
    waveTargetMoments.moment7 = generateTargetMoments(targetRadar, shipX, 7);
    waveTargetMoments.moment8 = generateTargetMoments(targetRadar, shipX, 8);
    waveTargetMoments.moment9 = generateTargetMoments(targetRadar, shipX, 9);
    waveTargetMoments.moment10 = generateTargetMoments(targetRadar, shipX, 10);
    waveTargetMoments.moment11 = generateTargetMoments(targetRadar, shipX, 11);
    waveTargetMoments.moment12 = generateTargetMoments(targetRadar, shipX, 12);
    waveTargetMoments.moment13 = generateTargetMoments(targetRadar, shipX, 13);
    return waveTargetMoments;    
}

function buildHordeMoments(state, flipped){
    
    function alienPlaceHolder(x,y,origX,origY){
        return { X: x, Y: y , originX: origX,originY: origY };
    }

    function calculateNextMoment(alienMoment, flipped){
        var aliveAliens = alienMoment.length;
        var alienTouchingWallRight = false;
        var alienTouchingWallLeft = false;
        var oddRow = (alienMoment[0].Y % 2)?(true):(false);
        oddRow = (flipped)?(!oddRow):(oddRow);
        for (var i = 0; i < aliveAliens; i++) {
            // check if an alien is at 1 or 17
            if (alienMoment[i].X == 1) { alienTouchingWallLeft = true;}
            if (alienMoment[i].X == 17) { alienTouchingWallRight = true; }
        }

        var nextMove;
        if (!alienTouchingWallLeft && !alienTouchingWallRight && oddRow) {
            nextMove = 'Left';
        }
        else if (!alienTouchingWallLeft && !alienTouchingWallRight && !oddRow) {
            nextMove =  'Right';
        }
        else if (alienTouchingWallLeft && oddRow) { 
            nextMove =  'Down';
        }
        else if (alienTouchingWallLeft && !oddRow) {
            nextMove =  'Right';
        }
        else if (alienTouchingWallRight && !oddRow) {
            nextMove =  'Down'
        }
        else {
            //alienTouchingWallRight && oddRow
            nextMove =  'Left'
        }
        // apply the move and return the new moment.
        var returnMoment = [];
        for (var i = 0; i < aliveAliens; i++) {
            var nextMomentAlien = new alienPlaceHolder(alienMoment[i].X, alienMoment[i].Y, alienMoment[i].originX, alienMoment[i].originY);
            switch (nextMove) {
                case 'Left':
                    nextMomentAlien.X = nextMomentAlien.X - 1;
                    break;
                case 'Right':
                    nextMomentAlien.X = nextMomentAlien.X + 1;
                    break;
                case 'Down':
                    nextMomentAlien.Y = nextMomentAlien.Y + 1;
                    break;
            }
            returnMoment.push(nextMomentAlien);
        }
        return returnMoment;
    }
        
    var hordeMoments = {
        moment0: [], 
        moment1: [], 
        moment2: [], 
        moment3: [], 
        moment4: [], 
        moment5: [], 
        moment6: [], 
        moment7: [], 
        moment8: [], 
        moment9: [],
        moment10: [],
        moment11: [],
        moment12: [],
        moment13: []
    };
    var activeWaves = state.Players[1].AlienManager.Waves.length;
    for (var i = 0; i < activeWaves; i++) {
        var aliensInWave = state.Players[1].AlienManager.Waves[i].length;
        for (var j = 0; j < aliensInWave; j++) {
            var alien = state.Players[1].AlienManager.Waves[i][j];
            if (alien.Alive) {
                hordeMoments.moment0.push(new alienPlaceHolder(alien.X, alien.Y, alien.X, alien.Y));
            }
        }
    }
    // If I am really player 2, then the direction will be flipped for the aliens.
    // now you have the current position of all aliens as they stand.
    hordeMoments.moment1 = calculateNextMoment(hordeMoments.moment0, flipped);
    hordeMoments.moment2 = calculateNextMoment(hordeMoments.moment1, flipped);
    hordeMoments.moment3 = calculateNextMoment(hordeMoments.moment2, flipped);
    hordeMoments.moment4 = calculateNextMoment(hordeMoments.moment3, flipped);
    hordeMoments.moment5 = calculateNextMoment(hordeMoments.moment4, flipped);
    hordeMoments.moment6 = calculateNextMoment(hordeMoments.moment5, flipped);
    hordeMoments.moment7 = calculateNextMoment(hordeMoments.moment6, flipped);
    hordeMoments.moment8 = calculateNextMoment(hordeMoments.moment7, flipped);
    hordeMoments.moment9 = calculateNextMoment(hordeMoments.moment8, flipped);
    hordeMoments.moment10 = calculateNextMoment(hordeMoments.moment9, flipped);
    hordeMoments.moment11 = calculateNextMoment(hordeMoments.moment10, flipped);
    hordeMoments.moment12 = calculateNextMoment(hordeMoments.moment11, flipped);
    hordeMoments.moment13 = calculateNextMoment(hordeMoments.moment12, flipped);
    return hordeMoments;
}

function buildMissleMoments(x,y){
    // pass in the xy of a missle here, and you will be able to see where it will be in 9 moments (projected)).
    return {
        moment1: { X: x, Y: (y - 1) }, 
        moment2: { X: x, Y: (y - 2) }, 
        moment3: { X: x, Y: (y - 3) },
        moment4: { X: x, Y: (y - 4) },
        moment5: { X: x, Y: (y - 5) },
        moment6: { X: x, Y: (y - 6) },
        moment7: { X: x, Y: (y - 7) },
        moment8: { X: x, Y: (y - 8) },
        moment9: { X: x, Y: (y - 9) },
        moment10: { X: x, Y: (y - 10) },
        moment11: { X: x, Y: (y - 11) },
        moment12: { X: x, Y: (y - 12) },
        moment13: { X: x, Y: (y - 13) },
    }
}

function findBestTargets(targetWaveFront, hordeMoments, activeMissleTrajectories){
    // what weight do you assign each level?
    var weightMoveMultiplier = 10;
    var weightLevelMultiplier = 50;
    // not taking left right into account yet...
    var weightPositionMultiplier = 30;
    var weightFutureMultiplier = 1;
    
    // since you can only decide in terms of a single move, just stick that in the opportunity.
    function targetOpportunity(weight, moments,nextMove, originX, originY){
        return {
            targetWeight: weight,
            momentsInFuture: moments,
            nextMove: nextMove,
            alienOriginX : originX,
            alienOriginY : originY,
        };
    }
    
    function checkMoment(hordeMoment, targetWaveMoment, missleMoments, momentsInTheFuture){
        var activeAliens = hordeMoment.length;
        var activeMissiles = missleMoments.length;
        var validTargets = [];
        for (var i = 0; i < activeAliens; i++) {
            // check if the alien is doomed.
            var alienDoomed = false;
            var momentAlien = hordeMoment[i];
            for (var k = 0; k < activeMissiles; k++) {
                if ((missleMoments[k].X == momentAlien.X) && (missleMoments[k].Y == momentAlien.Y)) {
                    alienDoomed = true;
                }
            }
            if (!alienDoomed) {
                for (var j = 0; j < targetWaveMoment.length; j++) {
                    if ((targetWaveMoment[j].x == momentAlien.X) &&
                    (targetWaveMoment[j].y == momentAlien.Y) &&
                    (!targetWaveMoment[j].inValid) && 
                    (!targetWaveMoment[j].blocked)) {
                        // the next move is based on the target wavefront - if no moves, then shoot, otherwise move
                        var move;
                        if (!targetWaveMoment[j].moveLeft && !targetWaveMoment[j].moveRight && !targetWaveMoment[j].pausing) {
                            move = 'Shoot';
                        }
                        else if (targetWaveMoment[j].moveLeft && !targetWaveMoment[j].pausing) {
                            move = 'MoveLeft'
                        }
                        else if (targetWaveMoment[j].moveRight && !targetWaveMoment[j].pausing){
                            move = 'MoveRight'
                        }
                        else {
                            move = 'Nothing';
                        }
                        // the weight is dropped by the amount you need to move.
                        var movementWeight = (targetWaveMoment[j].moveLeft + targetWaveMoment[j].moveRight) * weightMoveMultiplier;
                        // the weight is increased the lower the alien is. (12 is the middle row)
                        var levelWeight = (momentAlien.Y - 12) * weightLevelMultiplier;
                        // may need to add a multiplier as well for ones on the edge ***
                        // the longer something is in the future, the more the weight must drop - preference to earlier ones
                        var futureWeight = 100 - (weightFutureMultiplier * momentsInTheFuture);
                        // the weight is the sum of the contributing factors.
                        var targetWeight = futureWeight + levelWeight - movementWeight;
                        // if you can hit it in moment 1, its like RIGHT in front of you - SHOOT NOW! weight 100
                        validTargets.push(new targetOpportunity(
                            targetWeight,
                            momentsInTheFuture,
                            move, 
                            momentAlien.originX,
                            momentAlien.originY
                        ));
                    }
                }
            }
        }
        return validTargets;
    }
    
    var validTargets = [];
    // look at each moment. See which aliens will be hit at what moments, and then return like the top 5. remove aliens that will die
    // due to incoming missles. weight by how low each alien is maybe (two per row maybe), and add like 
    // 1 point the closer it is to the edge.
    
    // split up missle moments by moments.
    var misslesMoment1 = [];
    var misslesMoment2 = [];
    var misslesMoment3 = [];
    var misslesMoment4 = [];
    var misslesMoment5 = [];
    var misslesMoment6 = [];
    var misslesMoment7 = [];
    var misslesMoment8 = [];
    var misslesMoment9 = [];
    var misslesMoment10 = [];
    var misslesMoment11 = [];
    var misslesMoment12 = [];
    var misslesMoment13 = [];
    for (var i = 0; i < activeMissleTrajectories.length; i++) {
        misslesMoment1.push({ X: activeMissleTrajectories[i].moment1.X, Y: activeMissleTrajectories[i].moment1.Y });
        misslesMoment2.push({ X: activeMissleTrajectories[i].moment2.X, Y: activeMissleTrajectories[i].moment2.Y });
        misslesMoment3.push({ X: activeMissleTrajectories[i].moment3.X, Y: activeMissleTrajectories[i].moment3.Y });
        misslesMoment4.push({ X: activeMissleTrajectories[i].moment4.X, Y: activeMissleTrajectories[i].moment4.Y });
        misslesMoment5.push({ X: activeMissleTrajectories[i].moment5.X, Y: activeMissleTrajectories[i].moment5.Y });
        misslesMoment6.push({ X: activeMissleTrajectories[i].moment6.X, Y: activeMissleTrajectories[i].moment6.Y });
        misslesMoment7.push({ X: activeMissleTrajectories[i].moment7.X, Y: activeMissleTrajectories[i].moment7.Y });
        misslesMoment8.push({ X: activeMissleTrajectories[i].moment8.X, Y: activeMissleTrajectories[i].moment8.Y });
        misslesMoment9.push({ X: activeMissleTrajectories[i].moment9.X, Y: activeMissleTrajectories[i].moment9.Y });
        misslesMoment10.push({ X: activeMissleTrajectories[i].moment10.X, Y: activeMissleTrajectories[i].moment10.Y });
        misslesMoment11.push({ X: activeMissleTrajectories[i].moment11.X, Y: activeMissleTrajectories[i].moment11.Y });
        misslesMoment12.push({ X: activeMissleTrajectories[i].moment12.X, Y: activeMissleTrajectories[i].moment12.Y });
        misslesMoment13.push({ X: activeMissleTrajectories[i].moment13.X, Y: activeMissleTrajectories[i].moment13.Y });
    }

    validTargets = validTargets.concat(checkMoment(hordeMoments.moment1, targetWaveFront.moment1, misslesMoment1, 1));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment2, targetWaveFront.moment2, misslesMoment2, 2));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment3, targetWaveFront.moment3, misslesMoment3, 3));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment4, targetWaveFront.moment4, misslesMoment4, 4));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment5, targetWaveFront.moment5, misslesMoment5, 5));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment6, targetWaveFront.moment6, misslesMoment6, 6));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment7, targetWaveFront.moment7, misslesMoment7, 7));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment8, targetWaveFront.moment8, misslesMoment8, 8));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment9, targetWaveFront.moment9, misslesMoment9, 9));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment10, targetWaveFront.moment10, misslesMoment10, 10));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment11, targetWaveFront.moment11, misslesMoment11, 11));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment12, targetWaveFront.moment12, misslesMoment12, 12));
    validTargets = validTargets.concat(checkMoment(hordeMoments.moment13, targetWaveFront.moment13, misslesMoment13, 13));
      
    return validTargets;
}

function DoIHaveLivesAndNoMissleFactory(state) {
    //returns true if those two things are true
    return (!state.Players[0].MissileController && (state.Players[0].Lives > 0));
}

function DoIHaveLivesAndNoAlienFactory(state) {
    //returns true if those two things are true
    return (!state.Players[0].AlienFactory && (state.Players[0].Lives > 0));
}

function debugLogString(logString){
    util.log(logString);
}

function debugLogRadar(radar) {
    debugLogString('Radar:')
    var logRadarString = '';
    // long range
    logRadarString += (radar.Long.BL)?('X'):('0');
    logRadarString += (radar.Long.PL)?('X'):('0');
    logRadarString += (radar.Long.L)?('X'):('0');
    logRadarString += (radar.Long.M)?('X'):('0');
    logRadarString += (radar.Long.R)?('X'):('0');
    logRadarString += (radar.Long.PR)?('X'):('0');
    logRadarString += (radar.Long.BR)?('X'):('0');
    debugLogString(logRadarString);
    // medium range
    logRadarString = '.';
    logRadarString += (radar.Medium.BL)?('X'):('0');
    logRadarString += (radar.Medium.L)?('X'):('0');
    logRadarString += (radar.Medium.M)?('X'):('0');
    logRadarString += (radar.Medium.R)?('X'):('0');
    logRadarString += (radar.Medium.BR)?('X'):('0');
    logRadarString += '.';
    debugLogString(logRadarString);
    // Short Range
    logRadarString = '.';
    logRadarString += (radar.Close.PL)?('X'):('0');
    logRadarString += (radar.Close.L)?('X'):('0');
    logRadarString += (radar.Close.M)?('X'):('0');
    logRadarString += (radar.Close.R)?('X'):('0');
    logRadarString += (radar.Close.PR)?('X'):('0');
    logRadarString += '.';
    debugLogString(logRadarString);
}

function logTargettingState(playerInfo, validTargets) {
    debugLogString('I am :' + playerInfo.PlayerName);
    debugLogString('PlayerNumber :' + playerInfo.PlayerNumber);
    debugLogString('PlayerNumberReal :' + playerInfo.PlayerNumberReal);
    if (playerInfo.Ship) {
        debugLogString('My ship is at X:' + playerInfo.Ship.X + ' Y:'+ playerInfo.Ship.Y);
    }
    debugLogString('I am targetting :');
    for (var i = 0; i < validTargets.length; i++) {
        debugLogString('Alien @ X:'+ validTargets[i].alienOriginX + ' Y:' +validTargets[i].alienOriginY+' move:'+validTargets[i].nextMove+' weight:'+validTargets[i].targetWeight+' to hit:'+ validTargets[i].momentsInFuture);
    }
}