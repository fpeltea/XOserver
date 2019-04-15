const WebSocket = require('ws');
const redis = require('redis');
const asyncRedis = require('async-redis');
const uuidv4 = require('uuid/v4');

const path = require('path');
const INDEX = path.join(__dirname, 'index.html');


var PORT = process.env.PORT;

const server = express()
    .use((req, res) => res.sendFile(INDEX))
    .listen(PORT, () => console.log(`Listening on ${PORT}`));

var client = asyncRedis.createClient(process.env.REDIS_URL);

client.flushall();

const wss = new WebSocket.Server(server);

console.log("Server started");

var interval = null;

wss.on('connection', function connection(ws) {

    console.log("User connected");

    ws.isAlive = true;

    //heartbeat
    if (interval === null) {
        interval = setInterval(function () {
            wss.clients.forEach(function (ws) {
                if (ws.isAlive === false) {
                    console.log("Client with id " + ws.id + " not responsive, dropping.");
                    return ws.terminate();
                }

                ws.isAlive = false;
                let pingMessage = {
                    messageType: "ping"
                };

                ws.send(JSON.stringify(pingMessage));

            })
        }, 5000)
    }

    ws.id = uuidv4();
    ws.on('message', async function incoming(message) {
        //console.log("Received message: " + message);
        var parsedMessage = JSON.parse(message);

        switch (parsedMessage.requestType) {
            case "findGame":
                ws.isAlive = true;

                let gamesWaiting = await checkWaitingGames();
                if (gamesWaiting === true) {
                    console.log("Found game");

                    let gameID = await client.lpop("gamesWaiting");
                    let playerID = ws.id;
                    let opponentID = await client.hget(gameID, "playerX");

                    client.hset(gameID, "playerO", playerID);
                    client.hset("playerIndex", playerID, gameID);

                    let response = {
                        messageType: "foundGameInfo",
                        gameID: gameID,
                        playerID: playerID,
                        currentTurn: "X",
                        playerShape: "O"
                    };
                    ws.opponentid = opponentID;
                    ws.send(JSON.stringify(response));

                    let opponentClient = findClientByID(wss, opponentID);
                    opponentClient.opponentid = playerID;
                    let opponentMessage = {
                        messageType: "foundPlayer"
                    };

                    opponentClient.send(JSON.stringify(opponentMessage));

                } else {
                    console.log("No game found, creating new game...");
                    let newGameInfo = await createNewGame();

                    await client.rpush("gamesWaiting", newGameInfo.gameID);
                    client.hset("playerIndex", newGameInfo.playerX, newGameInfo.gameID);

                    ws.id = newGameInfo.playerX;
                    let response = {
                        messageType: "newGameInfo",
                        gameID: newGameInfo.gameID,
                        playerID: newGameInfo.playerX,
                        currentTurn: "X",
                        playerShape: "X"
                    };

                    ws.send(JSON.stringify(response));
                }

                break;

            case "move":
                ws.isAlive = true;

                let currentSpaces = await client.hget(parsedMessage.gameID, "spaces");
                currentSpaces = JSON.parse(currentSpaces);

                if (currentSpaces[parsedMessage.space] === null && await client.hget(parsedMessage.gameID, "currentTurn") === parsedMessage.playerShape) {
                    let storedID;
                    let opponentID;
                    if (parsedMessage.playerShape === "X") {
                        storedID = await client.hget(parsedMessage.gameID, "playerX");
                        opponentID = await client.hget(parsedMessage.gameID, "playerO");
                    } else if (parsedMessage.playerShape === "O") {
                        storedID = await client.hget(parsedMessage.gameID, "playerO");
                        opponentID = await client.hget(parsedMessage.gameID, "playerX");
                    }

                    if (parsedMessage.playerID === storedID) {
                        currentSpaces[parsedMessage.space] = parsedMessage.playerShape;
                        await client.hset(parsedMessage.gameID, "spaces", JSON.stringify(currentSpaces));

                        if (parsedMessage.playerShape === "X") {
                            await client.hset(parsedMessage.gameID, "currentTurn", "O");
                        } else {
                            await client.hset(parsedMessage.gameID, "currentTurn", "X");
                        }

                        let response = {
                            messageType: "moveConfirm"
                        };

                        //now to notify the opponent

                        let opponentClient = findClientByID(wss, opponentID);

                        let opponentMessage = {
                            messageType: "moveNotify",
                            space: parsedMessage.space,
                            shape: parsedMessage.playerShape
                        }

                        let endResult = checkEndCondition(currentSpaces);
                        if (endResult) {
                            response.endResult = endResult;
                            opponentMessage.endResult = endResult;
                            client.del(parsedMessage.gameID);
                            client.hdel("playerIndex", ws.id, opponentID);
                        };

                        ws.send(JSON.stringify(response));
                        opponentClient.send(JSON.stringify(opponentMessage));
                    }

                }

            case "pong":
                ws.isAlive = true;


        }
    });
    ws.on("close", async function () {
        let opponentClient = findClientByID(wss, ws.opponentid);
        let gameID = await client.hget("playerIndex", ws.id);
        if (gameID != null) {
            client.del(gameID);
            client.lrem("gamesWaiting", 1, gameID);
        }
        client.hdel("playerIndex", ws.id);
        if (opponentClient != undefined) {
            client.hdel("playerIndex", ws.opponentid);
            let opponentMessage = {
                messageType: "opponentDropped"
            }
            opponentClient.send(JSON.stringify(opponentMessage));
        };


        if (wss.clients.size === 0) {
            clearInterval(interval);
            interval = null;
        }
    });
})

async function checkWaitingGames() {
    // Checks if there's a game waiting for a second player
    let result = await client.llen('gamesWaiting');
    if (result > 0) {
        return true;
    } else {
        return false;
    }
}

async function createNewGame() {
    // Generates details of new game and sends them to DB. Returns an object

    console.log("Creating new game...");

    let game = {};
    game.gameID = uuidv4();
    console.log("Game ID is " + game.gameID);
    game.playerX = uuidv4();
    game.spaces = Array(9).fill(null);

    client.hset(game.gameID, "playerX", game.playerX);
    client.hset(game.gameID, "spaces", JSON.stringify(game.spaces));
    client.hset(game.gameID, "currentTurn", "X");

    return game;
}

function findClientByID(wss, id) {
    console.log("Searching for client by ID... ");
    if (id === undefined) {
        return undefined;
    }
    let result;
    wss.clients.forEach(function each(client) {
        if (client.id == id && client.id != undefined) {
            console.log("ID matches!");
            result = client;
        }
    });
    return result;
}

function checkEndCondition(spaces) {
    if (spaces[0] === spaces[1] && spaces[1] === spaces[2] && spaces[0] != null) {
        if (spaces[0] === "X" || spaces[0] === "O") {
            return spaces[0];
        }
    } else if (spaces[3] === spaces[4] && spaces[4] === spaces[5] && spaces[3] != null) {
        if (spaces[3] === "X" || spaces[3] === "O") {
            return spaces[3];
        }
    } else if (spaces[6] === spaces[7] && spaces[7] === spaces[8] && spaces[6] != null) {
        if (spaces[6] === "X" || spaces[6] === "O") {
            return spaces[6];
        }


    } else if (spaces[0] === spaces[3] && spaces[3] === spaces[6] && spaces[0] != null) {
        if (spaces[0] === "X" || spaces[0] === "O") {
            return spaces[0];
        }
    } else if (spaces[1] === spaces[4] && spaces[4] === spaces[7] && spaces[1] != null) {
        if (spaces[1] === "X" || spaces[1] === "O") {
            return spaces[1];
        }
    } else if (spaces[2] === spaces[5] && spaces[5] === spaces[8] && spaces[2] != null) {
        if (spaces[2] === "X" || spaces[2] === "O") {
            return spaces[2];
        }


    } else if (spaces[0] === spaces[4] && spaces[4] === spaces[8] && spaces[0] != null) {
        if (spaces[0] === "X" || spaces[0] === "O") {
            return spaces[0];
        }
    } else if (spaces[2] === spaces[4] && spaces[4] === spaces[6] && spaces[2] != null) {
        if (spaces[2] === "X" || spaces[2] === "O") {
            return spaces[2];
        }
    }

    if (spaces.find(function (element) { return element === null; }) === undefined) {
        return "DRAW";
    }

    return false;
}