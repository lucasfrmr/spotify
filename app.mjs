import { fileURLToPath } from 'url';
import path, { dirname } from 'path';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { MongoClient, ServerApiVersion } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { PORT, MONGODB, SPOTIFY_CLIENTID, SPOTIFY_CLIENTSECRET } = process.env;
let SPOTIFY_ACCESSTOKEN, SPOTIFY_ATEXPIRESAT, SPOTIFY_REFRESHTOKEN, SPOTIFY_CURRENTLYPLAYING;
const wssClients = new Set();

const app = express();

app.locals.pretty = true;
app.set('trust proxy', true);
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

const wss = new WebSocketServer({ 
	server: app.listen(PORT, () => { 
		console.log(`[${new Date().toISOString()}]: The NodeJS application (${__dirname.split('/').pop()}) is running on port ${PORT};`) 
	})
});

const mongo = new MongoClient(MONGODB, { serverApi: ServerApiVersion.v1 });

function generateRandomId(length) {
	const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}

wss.on('connection', async (ws, req) => {
	wssClients.add(ws);
	const wssClientId = generateRandomId(16);
	const wssClientIp = req.headers['x-forwarded-for'].split(',')[0].trim();

	console.log(`[${new Date().toISOString()}]: ${wssClientIp} websocket client (${wssClientId}) connected`);

	setInterval(() => {
		try {
			if (ws.readyState === WebSocket.OPEN) ws.ping();
		} catch (error) {
			console.error(`[${new Date().toISOString()}]: ${error.message}`);
		}
	}, 20e3);

	if (ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({
			type: 'spotify-currently-playing',
			data: SPOTIFY_CURRENTLYPLAYING
		}));

		try {
			const spotifyPlayerHistory = await mongo.db('spotify').collection('spotify-player-history').find({}).sort({ timestamp: -1 }).limit(20).toArray();
			ws.send(JSON.stringify({
				type: 'spotify-player-history',
				data: spotifyPlayerHistory
			}));
		} catch (error) {
			console.error(`[${new Date().toISOString()}]: ${error.message}`);
		}
	}

	ws.on('error', (error) => {
		wssClients.delete(ws);
		console.error(`[${new Date().toISOString()}]: ${wssClientIp} websocket client (${wssClientId}) encountered an error (${error.message})`);
	});

	ws.on('close', () => {
		wssClients.delete(ws);
		console.log(`[${new Date().toISOString()}]: ${wssClientIp} websocket client (${wssClientId}) disconnected`);
	});
});

wss.on('error', (error) => {
	console.error(`[${new Date().toISOString()}]: ${error.message}`);
});

async function refreshSpotifyAccessToken() {
	try {
		const requestOptions = {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Authorization': 'Basic ' + (new Buffer.from(`${SPOTIFY_CLIENTID}:${SPOTIFY_CLIENTSECRET}`).toString('base64'))
			},
			body: `grant_type=refresh_token&refresh_token=${SPOTIFY_REFRESHTOKEN}`
		};

		const spotifyResponse = await fetch('https://accounts.spotify.com/api/token', requestOptions);

		if (spotifyResponse.ok) {
			const spotifyAuthorizationData = await spotifyResponse.json();

			SPOTIFY_ACCESSTOKEN = spotifyAuthorizationData.access_token;
			SPOTIFY_ATEXPIRESAT = Date.now() + (spotifyAuthorizationData.expires_in * 1e3)

			// drop mongoDB database
			// await mongo.db('spotify').dropDatabase();

			try {
				await mongo.db('spotify').collection('spotify-authorization').updateOne({}, {
					$set: {
						access_token: SPOTIFY_ACCESSTOKEN,
						access_token_expires_at: SPOTIFY_ATEXPIRESAT
					}
				}, { upsert: true });

				console.log(`[${new Date().toISOString()}]: Successfully refreshed the access_token for Spotify Web API`);
			} catch (error) {
				console.error(`[${new Date().toISOString()}]: ${error.message}`);
				throw new Error('Failed to update the Spotify Web API access_token on MongoDB');
			}
		} else {
			throw new Error('Failed to refresh the access_token for Spotify Web API');
		}
	} catch (error) {
		console.error(`[${new Date().toISOString()}]: ${error.message}`);
	}
}

async function setSpotifyAuthorizationTokens() {
	try {
		if (!SPOTIFY_ACCESSTOKEN && !SPOTIFY_ATEXPIRESAT && !SPOTIFY_REFRESHTOKEN) {
			const spotifyAuthorizationData = await mongo.db('spotify').collection('spotify-authorization').findOne();

			if (!spotifyAuthorizationData) {
				throw new Error(`Authorize Spotify Web API at https://${__dirname.split('/').pop()}/login`);
			}

			SPOTIFY_ACCESSTOKEN = spotifyAuthorizationData.access_token;
			SPOTIFY_ATEXPIRESAT = spotifyAuthorizationData.access_token_expires_at;
			SPOTIFY_REFRESHTOKEN = spotifyAuthorizationData.refresh_token;

			if (SPOTIFY_ATEXPIRESAT - Date.now() < 300e3) await refreshSpotifyAccessToken();
		} else if (SPOTIFY_ATEXPIRESAT - Date.now() < 300e3) {
			await refreshSpotifyAccessToken();
		}

		setTimeout(setSpotifyAuthorizationTokens, (SPOTIFY_ATEXPIRESAT - Date.now()) - 300e3);
	} catch (error) {
		console.error(`[${new Date().toISOString()}]: ${error.message}`);
		return setTimeout(setSpotifyAuthorizationTokens, 60e3);
	}
}

await setSpotifyAuthorizationTokens();

async function saveSpotifyPlayerHistory() {
	try {
		const spotifyLastPlayed = await mongo.db('spotify').collection('spotify-player-history').findOne({}, { sort: { timestamp: -1 } });

		if (spotifyLastPlayed === null) {
			try {
				await mongo.db('spotify').collection('spotify-player-history').insertOne({
					item: SPOTIFY_CURRENTLYPLAYING.item,
					timestamp: SPOTIFY_CURRENTLYPLAYING.timestamp
				});
			} catch (error) {
				console.error(`[${new Date().toISOString()}]: ${error.message}`);
				throw new Error(`Failed to save currently playing from Spotify WEB API to MongoDB for spotify-player-history`);
			}
		} else {
			if (SPOTIFY_CURRENTLYPLAYING.item.uri != spotifyLastPlayed.item.uri) {
				try {
					await mongo.db('spotify').collection('spotify-player-history').insertOne({
						item: SPOTIFY_CURRENTLYPLAYING.item,
						timestamp: SPOTIFY_CURRENTLYPLAYING.timestamp
					});

					wssClients.forEach(async wsClient => {
						if (wsClient.readyState === WebSocket.OPEN) {
							wsClient.send(JSON.stringify({
								type: 'spotify-player-history-update',
								data: {
									item: SPOTIFY_CURRENTLYPLAYING.item,
									timestamp: SPOTIFY_CURRENTLYPLAYING.timestamp
								}
							}));
						}
					});

				} catch (error) {
					console.error(`[${new Date().toISOString()}]: ${error.message}`);
					throw new Error(`Failed to save currently playing from Spotify WEB API to MongoDB for spotify-player-history`);
				}
			}
		}
	} catch (error) {
		console.error(`[${new Date().toISOString()}]: ${error.message}`);
	}
}

async function setSpotifyCurrentlyPlaying() {
	try {
		const requestOptions = {
			method: 'GET',
			headers: { 'Authorization': `Bearer ${SPOTIFY_ACCESSTOKEN}` }
		};

		const spotifyResponse = await fetch('https://api.spotify.com/v1/me/player/currently-playing', requestOptions);

		if (spotifyResponse.ok && spotifyResponse.status === 200) {
			SPOTIFY_CURRENTLYPLAYING = await spotifyResponse.json();

			wssClients.forEach(async wsClient => {
				if (wsClient.readyState === WebSocket.OPEN) {
					wsClient.send(JSON.stringify({
						type: 'spotify-currently-playing',
						data: SPOTIFY_CURRENTLYPLAYING
					}));
				}
			});

			await saveSpotifyPlayerHistory();
		} else if (spotifyResponse.ok) {
			throw new Error(`Failed to get currently playing from Spotify WEB API (${spotifyResponse.statusText})`);
		}
	} catch (error) {
		console.error(`[${new Date().toISOString()}]: ${error.message}`);
		return setTimeout(setSpotifyCurrentlyPlaying, 5e3);
	}

	setTimeout(setSpotifyCurrentlyPlaying, 1e3);
}

await setSpotifyCurrentlyPlaying();



app.get('/', async (req, res) => {
	res.sendFile(__dirname + '/views/index.html');
});

app.get('/login', (req, res) => {
	const params = new URLSearchParams({
		client_id: SPOTIFY_CLIENTID,
		response_type: 'code',
		redirect_uri: `https://${__dirname.split('/').pop()}/callback`,
		scope: 'user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played'
	});
	res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

app.get('/callback', async (req, res) => {
	const callbackCode = req.query.code;
	if (callbackCode) {
		try {
			const requestOptions = {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Authorization': 'Basic ' + (new Buffer.from(`${SPOTIFY_CLIENTID}:${SPOTIFY_CLIENTSECRET}`).toString('base64'))
				},
				body: `grant_type=authorization_code&code=${callbackCode}&redirect_uri=https://${__dirname.split('/').pop()}/callback`
			};
			const requestResponse = await fetch('https://accounts.spotify.com/api/token', requestOptions);
			if (requestResponse.ok) {
				const data = await requestResponse.json();
				try {
					await mongo.db('spotify').collection('spotify-authorization').updateOne({}, {
						$set: {
							access_token: data.access_token,
							access_token_expires_at: Date.now() + (data.expires_in * 1e3),
							refresh_token: data.refresh_token
						}
					}, { upsert: true });
					SPOTIFY_ACCESSTOKEN = data.access_token;
					SPOTIFY_REFRESHTOKEN = data.refresh_token;
					res.redirect('/');
				} catch (error) {
					console.error(`[${new Date().toISOString()}]: ${error.message}`);
					throw new Error('Failed to save the access_token and refresh_token from Spotify Web API to MongoDB');
				}
			} else {
				throw new Error('Failed to request the access_token and refresh_token from Spotify Web API');
			}
		} catch (error) {
			console.error(`[${new Date().toISOString()}]: ${error.message}`);
			res.sendStatus(500);
		}
	} else {
		res.sendStatus(401);
	}
});

app.use('/robots.txt', (req, res) => {
	res.type('text/plain');
	res.send('User-agent: *\nDisallow: /');
});
