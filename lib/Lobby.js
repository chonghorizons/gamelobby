"use strict";

var Player = require('./Player.js');

/**
 * Lobby
 *
 * A lobby for a game, running or not
 */
class Lobby {
  constructor (config={}) {
    // Initialized as lobby
    this.lobbyStatus = Lobby.WAITING; // Set initial status
    this.playerList = [];
    this.MINIMUM_PLAYER_COUNT_BEFORE_DC_GAMEOVER = config.MINIMUM_PLAYER_COUNT_BEFORE_DC_GAMEOVER || 2;

    this.setupConfig(config);

    this.scheduleDisconnectCheck();
  }

  updateStatus (newStatus) { this.lobbyStatus = newStatus; }
  getStatus (newStatus) { return this.lobbyStatus; }
  isWaitingInLobby () { return this.getStatus() == Lobby.WAITING; }
  isGamePlaying () { return this.getStatus() == Lobby.PLAYING; }

  getLobbyId () {
    // Using the socketRoomName as lobby ID
    return this.socketRoomName;
  }
  setupConfig (config) {
    // Set up game configuration
    this.config = {};

    // Optional User defined game lobby config
    this.config['playerCountForGame'] = config.playerCountForGame || 2;
    this.config['isFriendLobby'] = config.isFriendLobby || false;

    // Dynamic game config given by lobby manager
    this.socketRoomName = config.socketRoomName;
    this.lobbyManager = config.lobbyManager;
  }
  getConfigItem (itemName) {
    return this.config[itemName];
  }
  scheduleDisconnectCheck () {
    this.dcTimeoutInt = setTimeout(this.checkForDisconnects.bind(this), 2000);
  }
  checkForDisconnects () {
    var now = new Date();
    var timeoutThreshold = this.isWaitingInLobby() ? Lobby.LOBBY_TIMEOUT : Lobby.INGAME_TIMEOUT;

    // Can occur in a lobby, but never in Lobby.PLAYING state... Shouldn't happen now
    if (!this.playerList.length) {
      return console.log("[D] LOBBY_DC_CHECK_NO_PLAYERS");
    }

    var disconnectedList = this.playerList.filter((player, index) => {
      return (now - player.lastHeartbeatTime) > timeoutThreshold;
        // || !player.socket.isValidOrSomethingOrIsInRoom
    });

    // Don't want to call handleDisconnect outside of ingame/inlobby
    if (disconnectedList.length && (this.isWaitingInLobby() || this.isGamePlaying())) {
        // Handle disconnections. Game may end here
        this.handleDisconnect(disconnectedList);
    }

    // Perform check to see if this game has taken WAY too long
    if (this.isGamePlaying() &&
      (now - this.startTime > Lobby.TIMEOUT_FOR_TOTAL_GAME_RUNTIME)) {

      // Game has gone on way too long. Closing, killing.
      return this.endGame({REASON: Lobby.TIMEOUT_FOR_TOTAL_GAME_RUNTIME});
    }

    // Schedule next check if the game/lobby is still open
    if (this.isWaitingInLobby() || this.isGamePlaying()) {
      this.scheduleDisconnectCheck();
    }
  }
  destroyLobby () {
    this.updateStatus(Lobby.DESTROYED);
    clearTimeout(this.dcTimeoutInt); // don't check for DCs anymore
    this.clearRoom();
    this.lobbyManager.destroyLobby(this);
  }
  jsonSerializePlayerArray (players) {
    var json = [];
    players.forEach((player, index) => {
      json.push(player.toJsonObj());
    });
    return json;
  }
  // Called when someone closes the game OR a disconnect timeout occurs
  handleDisconnect (disconnectedList) {
    this.emitDisconnect(disconnectedList);

    //console.log("[D] GOT A DISCONNECT - ", disconnectedList, "lobbyStatus:", this.getStatus());

    // Determine what to do based on lobbyStatus
    if (this.isWaitingInLobby()) {
      this.gameFilledTime = null; // game not eligible to start yet

      // Remove player from lobby
      disconnectedList.forEach((player, index) => {
        this.removePlayer(player);
      });

      // Delete lobby if no players and game not started
      if (this.playerList.length == 0) {
        this.destroyLobby();
      }
    } else if (this.isGamePlaying()) {
      // Don't remove from game, just mark disconnected
      disconnectedList.forEach((player, index) => {
        player.status = Player.DISCONNECTED;
      });

      var connectedPlayerCount = this.playerList.filter((player, index) => {
        return player.status == Player.CONNECTED;
      }).length;

      // Check if enough players to continue the game
      if (connectedPlayerCount < this.MINIMUM_PLAYER_COUNT_BEFORE_DC_GAMEOVER) {
        this.endGame({REASON: Lobby.DISCONNECTED});
      } // Else game continues
    }
    // Else Some other Lobby status... Do nothing. Shouldn't get here
  }
  broadcastNewEvent (originatingPlayer, eventName, jsonData, shouldExcludeOriginatingPlayer=false) {
    if (shouldExcludeOriginatingPlayer) {
      sails.sockets.broadcast(this.getSocketRoomName(), eventName, jsonData, originatingPlayer.socket);
    } else {
      sails.sockets.broadcast(this.getSocketRoomName(), eventName, jsonData);
    }
  }
  emitEventToSinglePlayer (targetPlayer, eventName, jsonData) {
		sails.sockets.broadcast(targetPlayer.socket.id, eventName, jsonData);
  }
  addToRoom (player) {
    // add to socket room - can be overridden
    sails.sockets.join(player.socket, this.getSocketRoomName());
  }
  removeFromSocketRoom (player) {
    sails.sockets.leave(player.socket, this.getSocketRoomName());
  }
  clearRoom () {
    // Remove remaining sockets from room and close lobby
    this.playerList.forEach((player, index) => {
      this.removeFromSocketRoom(player);
    });
  }
  emitPlayerAdded (player) {
    // Emit new player name
    this.broadcastNewEvent(null, 'PLAYER_ADDED', {
      playerList: this.jsonSerializePlayerArray(this.playerList),
    });
  }
  emitGameStart () {
    // Emit start stuff
    this.broadcastNewEvent(null, "GAME_START", {
      startPage: this.getConfigItem('startPage'),
      startPageEncrypted: CryptoService.encrypt(this.getConfigItem('startPage'), this.getLobbyId()),
      goalPage: this.getConfigItem('goalPage'),
      playerList: this.jsonSerializePlayerArray(this.playerList),
    });
  }
  emitGameWon (winner) {
    // Send GAME_WON to the winner
    this.emitEventToSinglePlayer(winner, "GAME_WON", { filler: 'filler', });

    // Send GAME_LOST to the losers
    this.broadcastNewEvent(winner, "GAME_LOST", {
      winner: winner.toJsonObj(),
    }, true);  // omit winner socket
  }
  emitDisconnect (disconnectedList) {
    disconnectedList.forEach((player, index) => {
      // Will the player already be gone from the socket room??
      this.removeFromSocketRoom(player);
    });

    // Emit disconnect to still connected sockets
    this.broadcastNewEvent(null, "USER_DISCONNECT", {
      disconnectedList: this.jsonSerializePlayerArray(disconnectedList),
    });
  }
  emitGameOverDueToDisconnects () {
    // Emit disconnect to still connected sockets
    this.broadcastNewEvent(null, "GAME_OVER_DUE_TO_DISCONNECTS", {
      updatedPlayerList: this.jsonSerializePlayerArray(this.players),
    });
  }
  getSocketRoomName () { return this.socketRoomName; }
  getPlayerBySocket (socket) {
    var foundPlayer = null;
    this.playerList.forEach((player, index) => {
      if (player.socket == socket) {
        foundPlayer = player;
      }
    });

    return foundPlayer;
  }
  addPlayer (newPlayer) {
    // Check username uniqueness of this lobby
    for (var i in this.playerList) {
      if (this.playerList[i].username == newPlayer.username) {
        return false;
      }
    }

    this.playerList.push(newPlayer);
    this.emitPlayerAdded(newPlayer);
    this.addToRoom(newPlayer);

    // Game full, but NOT starting yet.
    // Start in the heartbeat check when we KNOW for sure each person's
    // latest heartbeat is AFTER right now
    if (this.isFull()) {
      this.gameFilledTime = new Date();
    }

    return true; // was added successfully
  }
  removePlayer (player) {
    this.playerList.splice(this.playerList.indexOf(player), 1);
  }
  // NOTE: This is a good function to override in a subclass
  startGame () {
    console.log("[D] Starting game!");
    this.updateStatus(Lobby.PLAYING);
    this.startTime = new Date();
    this.lobbyManager.tellLobbyManagerGameStarted(this);
    this.emitGameStart();
  }
  // Perform endgame analysis stuff and store data
  // NOTE: FEEL FREE TO EXTEND THE gamelobby.Lobby CLASS AND OVERRIDE THE endGame METHOD
  endGame (args, shouldDestroyLobby=true) {
    clearTimeout(this.dcTimeoutInt); // don't check for DCs anymore
    this.updateStatus(args.REASON); // Update status
    this.endTime = new Date();

    // XXX Will need to add some checks here to look for disconnect status

    // If this game was a timeout from going on too long
    if (this.getStatus() == Lobby.TIMEOUT_FOR_TOTAL_GAME_RUNTIME) {
      // Just pretend the game never even happened
      this.broadcastNewEvent(null, 'TOOK_WAY_TOO_LONG', {});
      return this.destroyLobby();
    }

    // XXX Also set other team winners here... or something?
    if (args.winner) {
      args.winner.status = Player.WIN;
    }

    // Update still connected people to losers
    this.playerList.forEach((player, index) => {
      if (player.status == Player.CONNECTED) {
        player.status = Player.LOST;
      }
    });

    // Let everyone know game results
    if (args.winner) {
      this.emitGameWon(args.winner);
    } else if (this.getStatus() == Lobby.DISCONNECTED) {
      this.emitGameOverDueToDisconnects();
    }

    if (shouldDestroyLobby) {
      this.destroyLobby();
    }
  }
  areAllPlayerHeartbeatsAfterTime (time) {
    return this.playerList.filter((player, i) => {
      return player.lastHeartbeatTime < time;
    }).length == 0;
  }
  haveAllPlayersHeartbeatedSinceFilling () {
    return this.gameFilledTime && this.areAllPlayerHeartbeatsAfterTime(this.gameFilledTime);
  }
  updateClientHeartbeat (socket, time) {
    // yes, additional hash table would be faster, but would use more memory
    var player = this.getPlayerBySocket(socket);
    if (!player) {
      return console.log("NO_PLAYER_FOUND_IN_UPDATEHEARTBEAT")
    }

    player.lastHeartbeatTime = time;

    // If we have enough, and everyone's latest heartbeat is AFTER the fill time,
    // start game!
    if (this.isFull() && this.isWaitingInLobby() && this.haveAllPlayersHeartbeatedSinceFilling()) {
      this.startGame();
    }
  }
  getSocketCount () {
    // XXX I'm not sure which one is more robust...
    // it depends on whether closed sockets are automatically removed
    // completely from all rooms on closing. Might find out later
    return this.playerList.length;
    //return sails.sockets.subscribers(this.getSocketRoomName()).length;
  }
  isFull () { return this.getSocketCount() == this.getConfigItem('playerCountForGame'); }
};

// Static Lobby class Statuses
// Assign each attribute directly onto Lobby class
Object.assign(Lobby, {
  JUSTCREATED: "JUSTCREATED", // only applicable to client
  WAITING: "WAITING",
  PLAYING: "PLAYING",
  GAME_COMPLETE: "GAME_COMPLETE",
  DESTROYED: "DESTROYED",
  DISCONNECTED: "DISCONNECTED", // Status for game end by disconnect
  LOBBY_TIMEOUT: 8000, // specified in ms
  INGAME_TIMEOUT: 30000, // specified in ms
  TIMEOUT_FOR_TOTAL_GAME_RUNTIME: 2*60*60*1000, // specified in ms... 2 hours
});


module.exports = Lobby;