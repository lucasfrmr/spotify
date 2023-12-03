import express from 'express';
import { MongoClient, ServerApiVersion } from "mongodb";
import fs from 'fs';
import { WebSocketServer } from 'ws';

const { PORT, MONGODB, AUTH, OPENAI_API_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
const client = new MongoClient(MONGODB, { serverApi: ServerApiVersion.v1 });
const redirect_uri = 'https://spotify.lucasfarmer.com/callback';

const app = express();
const server = app.listen(PORT, () => { console.log(`The NodeJS application is running on port ${PORT};`) });
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'pug');
app.set('views', './views');
app.locals.pretty = true;

const db = client.db('LFDEV');
const collection = db.collection('spotify');

const interval = 4000;
let globalAccessToken;
let globalRefreshToken;
let refreshIntervalId;

console.log('Starting Spotify app');

async function loadAccessToken() {
    try {
        const tokenInfo = await client.db('LFDEV').collection('spotify_info').findOne({}, { sort: { _timestamp: -1 } });
        if (tokenInfo) {
            globalAccessToken = tokenInfo.access_token;
            globalRefreshToken = tokenInfo.refresh_token;
            console.log('Loaded tokens from DB. Access token:', globalAccessToken, 'Refresh token:', globalRefreshToken);
        } else {
            console.log('No token info found in DB');
        }
    } catch (err) {
        console.error('Error loading access token from DB:', err);
    }
}
loadAccessToken();

wss.on('connection', (ws) => {
    console.log('A user connected');
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    ws.on('message', async (message) => {
        // console.log('Received message:', message);
        const data = JSON.parse(message);

        switch (data.action) {
            case 'search':
                const searchResults = await searchSpotify(data.query);
                ws.send(JSON.stringify({ type: 'search-results', results: searchResults }));
                break;
            case 'add-to-queue':
                await addToQueue(data.trackUri, ws);
                break;
            case 'get-queue':
                const queueData = await getQueueData();
                ws.send(JSON.stringify({ type: 'queue-data', queueItems: queueData }));
                break;
            case 'get-playlist':
                const playlistData = await getPlaylistData(data.playlistId);
                ws.send(JSON.stringify({ type: 'playlist-data', playlistItems: playlistData }));
                break;
            case 'submit-playlist':
                await handlePlaylistSubmission(data);
                break;
            case 'get-playlists':
                try {
                    const playlists = await db.collection('playlists').find({}).toArray();
                    ws.send(JSON.stringify({ type: 'playlist-data', playlists }));
                } catch (err) {
                    console.error('Error fetching playlists:', err);
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to fetch playlists' }));
                }
                break;
        }
    });

    ws.on('close', () => {
        console.log('A user disconnected');
    });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 4e4);

function updateSong(song, progress_ms) {
    console.log('Updating song:', song);
    const songData = {
        type: 'track-change',
        track: {
            trackId: song.trackId,
            artistId: song.artistId,
            artistName: song.artistName,
            trackName: song.trackName,
            albumName: song.albumName,
            artistImageUrl: song.artistImageUrl,
            trackDuration: song.trackDuration,
        },
        progress_ms: progress_ms
    };

    wss.clients.forEach((client) => {
        client.send(JSON.stringify(songData));
    });
}

async function getQueueData() {
    try {
        const response = await fetch('https://api.spotify.com/v1/me/player/queue', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${globalAccessToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Spotify API request failed: ' + response.statusText);
        }

        const data = await response.json();
        return data;
    } catch (err) {
        console.error('Error in getQueueData:', err);
        return [];
    }
}


async function searchSpotify(query) {
    const spotifyApiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track`;
    const response = await fetch(spotifyApiUrl, {
        headers: { 'Authorization': `Bearer ${globalAccessToken}` }
    });

    if (!response.ok) {
        console.error('Spotify API search error:', response.statusText);
        return [];
    }

    const data = await response.json();
    return data.tracks.items;
}

let myQueue = []; // This will store your custom queue

async function addToQueue(trackUri, ws) {
    try {
        const trackId = trackUri.split(':').pop();

        // Fetch song details to check its length
        const songDetails = await fetchSongDetails(trackId); // Implement this function to fetch song details from Spotify
        if (songDetails.duration_ms > 480000) {
            ws.send(JSON.stringify({ type: 'queue-error', message: 'Song is longer than 8 minutes' }));
            return;
        }

        // Check if song is already in the current Spotify queue
        const currentQueue = await getQueueData();
        if (currentQueue.queue && currentQueue.queue.some(queue => queue.id === trackId)) {

            ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'Song is already in the queue' }));
            return;
        }

        // Check if song has been played in the last 12 hours
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).getTime();
        const recentPlay = await db.collection('spotify').findOne({
            trackId: trackId,
            _timestamp: { $gte: twelveHoursAgo }
        });

        if (recentPlay) {
            const availableAt = new Date(recentPlay._timestamp + 12 * 60 * 60 * 1000);
            const availableAtString = availableAt.toLocaleString('en-US', { timeZone: 'CST6CDT' });
            ws.send(JSON.stringify({
                type: 'queue-update',
                status: 'error',
                message: 'This song has been played in the last 12 hours.',
                availableAt: availableAtString
            }));
            return;
        }

        // Add song to Spotify's queue
        const spotifyApiUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`;
        const response = await fetch(spotifyApiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error adding track to queue:', errorData);
            ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'Error adding track to queue' }));
        } else {
            // Add to custom queue
            addToMyQueue({ trackId: trackId, trackUri: trackUri });
            ws.send(JSON.stringify({ type: 'queue-update', status: 'added' }));
        }
    } catch (error) {
        console.error('Error in addToQueue:', error);
        ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'An error occurred while adding the track to the queue.' }));
    }
}

function addToMyQueue(songDetails) {
    myQueue.push(songDetails);
}

function removeFromMyQueue(trackId) {
    myQueue = myQueue.filter(song => song.trackId !== trackId);
}

function isSongInMyQueue(trackId) {
    return myQueue.some(song => song.trackId === trackId);
}

async function fetchSongDetails(trackId) {
    const url = `https://api.spotify.com/v1/tracks/${trackId}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${globalAccessToken}` }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch song details');
    }
    return await response.json();
}

async function getCurrentPlayingTrack(access_token) {
    const url = 'https://api.spotify.com/v1/me/player/currently-playing';
    const headers = { 'Authorization': `Bearer ${access_token}` };
    

    try {
        const response = await fetch(url, { headers });
        if (!response.ok) {
            return;
        }
        const body = await response.json();
        if (!body.item) {
            return;
        }
        const track = body.item;
        const recentTrack = await collection.findOne({}, { sort: { _timestamp: -1 } });
        if (!recentTrack || recentTrack.trackId !== track.id) {
            let artistImageUrl = null;
            if (track.artists.length > 0) {
                const firstArtistResponse = await fetch(`https://api.spotify.com/v1/artists/${track.artists[0].id}`, { headers });
                const firstArtistData = await firstArtistResponse.json();
                artistImageUrl = firstArtistData.images && firstArtistData.images.length > 0 ? firstArtistData.images[0].url : null;
            }

            const newTrackEntry = {
                _timestamp: Date.now(),
                trackId: track.id,
                trackName: track.name,
                trackDuration: track.duration_ms,
                artistId: track.artists.length > 0 ? track.artists[0].id : null,
                artistName: track.artists.length > 0 ? track.artists[0].name : null,
                artistImageUrl: artistImageUrl,
                albumId: track.album.id,
                albumName: track.album.name,
                albumImageUrl: track.album.images && track.album.images.length > 0 ? track.album.images[0].url : null
            };
            console.log('trackDuration: ', newTrackEntry.trackDuration);
            await collection.insertOne(newTrackEntry);
            updateSong(newTrackEntry, body.progress_ms);
            // console.log(`Track (${track.id}) has been logged`);
        } else {
            // updateSong(recentTrack, body.progress_ms);
            // console.log('Track is already in the database');
        }
    } catch (err) {
        console.error('Error in getCurrentPlayingTrack:', err);
    }
}

async function getPlaylistData(playlistUrl) {
    try {
        const urlParts = playlistUrl.split('/');
        const playlistIdPart = urlParts[urlParts.length - 1];
        const playlistId = playlistIdPart.split('?')[0];

        const playlistApiUrl = `https://api.spotify.com/v1/playlists/${playlistId}`;

        const response = await fetch(playlistApiUrl, {
            headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        });

        if (!response.ok) {
            console.error('Spotify API playlist error:', response.statusText);
            return [];
        }

        const data = await response.json();
        return data.tracks.items;
    } catch (err) {
        console.error('Error getting playlist data:', err);
        return [];
    }
}

async function handlePlaylistSubmission(data) {
    try {
        const { user, playlistName, tracks } = data;
        const playlistDocument = {
            userName: user,
            playlistName: playlistName,
            tracks: tracks.map(track => ({
                trackId: track.id,
                trackName: track.name,
                trackDuration: track.duration_ms,
                artistId: track.artists[0].id,
                artistName: track.artists[0].name,
                albumId: track.album.id,
                albumName: track.album.name,
                albumImageUrl: track.album.images[0].url
            })),
            createdAt: new Date()
        };
        await db.collection('playlists').insertOne(playlistDocument);
        console.log('Playlist submitted successfully');
    } catch (err) {
        console.error('Error submitting playlist:', err);
    }
}


app.get(['/', '/tracks'], async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 20;
        const totalTracks = await collection.countDocuments();
        const tracks = await collection.find({}).skip((page - 1) * pageSize).limit(pageSize).sort({_timestamp: -1}).toArray();
        const recentTrack = tracks[0];

        res.render('tracks', { tracks, recentTrack, page, totalTracks, pageSize });
    } catch (err) {
        console.error(err);
        res.status(500).send('Server error');
    }
});

// authintication stuff
app.get('/login', (req, res) => {
    const scope = 'user-read-currently-playing user-read-recently-played user-modify-playback-state user-read-playback-state';
    res.redirect('https://accounts.spotify.com/authorize?' +
    'response_type=code' +
    '&client_id=' + SPOTIFY_CLIENT_ID +
    (scope ? '&scope=' + encodeURIComponent(scope) : '') +
    '&redirect_uri=' + encodeURIComponent(redirect_uri));
});

app.get('/callback', async (req, res) => {
    console.log('/callback');
    const code = req.query.code;

    const authOptions = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            code: code,
            redirect_uri: redirect_uri,
            grant_type: 'authorization_code'
        })
    };

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', authOptions);

        if (!response.ok) {
            throw new Error('Failed to retrieve access token: ' + response.statusText);
        }

        const body = await response.json();
        const access_token = body.access_token;
        const refresh_token = body.refresh_token;

        client.db('LFDEV').collection('spotify_info').updateOne({}, { $set: { timestamp: Date.now(), access_token, refresh_token } }, { upsert: true });
        globalAccessToken = access_token;
        
        res.send('Success! You can now close the window.');
    } catch (err) {
        console.error('Error in /callback:', err);
        res.send('Failed to retrieve access token.');
    }
});

async function refreshAccessToken() {
    if (!globalRefreshToken) {
        console.error('Refresh token is null, cannot refresh access token');
        return;
    }

    console.log('Refreshing access token');

    const authOptions = {
        method: 'POST',
        headers: {
            'Authorization': 'Basic ' + (Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64')),
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: globalRefreshToken
        })
    };

    try {
        const response = await fetch('https://accounts.spotify.com/api/token', authOptions);

        if (!response.ok) {
            throw new Error('Failed to refresh access token: ' + response.statusText);
        }

        const body = await response.json();
        globalAccessToken = body.access_token;
        globalRefreshToken = body.refresh_token || globalRefreshToken;
        await client.db('LFDEV').collection('spotify_info').updateOne({}, { $set: { timestamp: Date.now(), access_token: globalAccessToken, refresh_token: globalRefreshToken } }, { upsert: true });
        console.log('Access token refreshed and updated in the database.');
    } catch (err) {
        console.error('Error during token refresh:', err);
    }
}

const refreshInterval = 1 * 60 * 1000;  // 55 minutes in milliseconds
setInterval(async () => {
    const tokenInfo = await client.db('LFDEV').collection('spotify_info').findOne({}, { sort: { _timestamp: -1 } });
    console.log((Date.now() - tokenInfo.timestamp), refreshInterval)
    if ((Date.now() - tokenInfo.timestamp) > refreshInterval) {
        refreshAccessToken(globalRefreshToken); // Ensure globalRefreshToken is correctly initialized and updated
    };
}, refreshInterval);

setInterval(async () => {
    await getCurrentPlayingTrack(globalAccessToken);
}, interval);