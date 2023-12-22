import express from 'express';
// import session from 'express-session';
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
// app.use(session({
//     secret: 'bugEyedCat', // Replace 'your-secret-key' with a real secret string
//     resave: false,
//     saveUninitialized: true,
//     cookie: { secure: 'auto' } // 'auto' will use secure cookies if the site is using HTTPS
// }));


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

app.get('/song-analysis', async (req, res) => {
    if (!req.query.trackId) {
        res.status(400).json({ error: 'trackId is required' });
        return;
    }
    console.log('song analysis requested for trackId:', req.query.trackId);
    try {
        const trackId = req.query.trackId;
        const analysis = await fetchSongAnalysis(trackId);
        res.json(analysis);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Failed to fetch song analysis' });
    }
});


async function loadAccessToken() {
    try {
        const tokenInfo = await client.db('LFDEV').collection('spotify_info').findOne({}, { sort: { _timestamp: -1 } });
        if (tokenInfo) {
            globalAccessToken = tokenInfo.access_token;
            globalRefreshToken = tokenInfo.refresh_token;
            console.log('Access token loaded from DB');
            console.log('Access token:  ',globalAccessToken);
            console.log('Refresh token: ', globalRefreshToken);
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
            // case 'get-user-queue':
            //     const username = data.username;
            //     const userQueue = await getUserQueue(username);
            //     ws.send(JSON.stringify({ type: 'user-queue', queueItems: userQueue }));
            //     break;
            // Assuming this is within the WebSocket message handling
            case 'get-user-queue':
                const userQueue = await getUserQueue(data.username);
                console.log('Sending user queue:', userQueue.length); // Log for debugging
                ws.send(JSON.stringify({ type: 'user-queue', queueItems: userQueue }));
                break;

            case 'queueOldestUnplayedSong':
                // getRoundRobinQueue();
                // queueOldestUnplayedSong();
                roundRobinQueueSongs();
                break;
            case 'fetch-song-analysis':
                console.log('fetch-song-analysis');
                // send song song-analysis
                const songAnalysis = await fetchSongAnalysis(data.trackId);
                ws.send(JSON.stringify({ type: 'song-analysis', songAnalytics }));
                break;
            case 'login':
                console.log('Login attempt:', data.username);
                const user = await db.collection('spotifyUsers').findOne({ username: data.username });
                if (!user) {
                    // Create a new record
                    // const newUser = { username: data.username };
                    createUser(data.username);
                    console.log('New user record created:', data.username);
                }
                if (user) {
                    ws.send(JSON.stringify({ type: 'login-success', message: 'Login successful' }));
                } else {
                    ws.send(JSON.stringify({ type: 'login-error', message: 'Invalid username' }));
                }
                break;
            case 'search':
                console.log('username is:', data.username);
                const searchResults = await searchSpotify(data.query);
                ws.send(JSON.stringify({ type: 'search-results', results: searchResults }));
                break;
            case 'add-to-queue':
                console.log('add-to-queue ' + data.trackUri + ' ' + data.username);
                await addToUserQueue(data.trackUri, data.username, ws);
                // console.log(username, 'is adding track to queue:', data.trackUri);
                break;
            case 'remove-from-queue':
                await removeFromQueue(data.trackUri, username, ws);
                break;
            case 'get-queue':
                const virtualQueue = await getRoundRobinQueue();
                console.log('Sending virtualQueue to client:')
                ws.send(JSON.stringify({ type: 'queue-data', queueItems: virtualQueue }));
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
        console.log('Ping sent');
    });
}, 4e4);

async function getUserQueue(username) {
    console.log('Getting queue for user:', username);
    try {
        const userQueueData = await db.collection('users').findOne({ username: username }, { projection: { queuedSongs: 1 } });
        return userQueueData ? userQueueData.queuedSongs : [];
    } catch (err) {
        console.error('Error in getUserQueue:', err);
        return [];
    }
}

function updateSong(song, progress_ms) {
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
    const spotifyApiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=50`;
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

async function createUser(username) {
    try {
        const db = client.db('LFDEV'); // Replace 'LFDEV' with your database name
        const collection = db.collection('users'); // Replace 'users' with your collection name

        // Create a unique index on the 'username' field
        await collection.createIndex({ username: 1 }, { unique: true });

        // Check if the username already exists
        const existingUser = await collection.findOne({ username: username });

        if (existingUser) {
            // Handle the situation where the username already exists
            console.log('User already exists:', existingUser);
            // You can return an error message or take appropriate action
        } else {
            // Proceed with user creation since the username is unique
            const userDocument = {
                username: username,
                createdAt: new Date(),
                roundedRobin: false,
                queuedSongs: []
            };

            // Insert the new user document into the collection
            await collection.insertOne(userDocument);
            console.log('User created successfully:', userDocument);
            // You can return a success message or perform additional actions
        }
    } catch (err) {
        console.error('Error creating user with unique index:', err);
        // Handle the error appropriately
    }
}



async function addSongToQueue(username, trackUri, trackName, artistName, duration_ms) {
    try {
        // Check if the user already exists
        const userExists = await db.collection('users').findOne({ username: username });

        if (!userExists) {
            console.log('User does not exist:', username);
            // You can handle the user not existing here, such as creating a new user
            // or simply returning an error message
            return;
        }

        // Check if the song is already in the user's queue
        const songExists = await db.collection('users').findOne({ 
            username: username, 
            'queuedSongs.trackUri': trackUri 
        });

        if (songExists) {
            console.log('Song already exists in the queue for user:', username);
            return;
        }

        // If the song doesn't exist, add it to the user's queue
        await db.collection('users').updateOne(
            { username: username },
            { 
                $push: { 
                    queuedSongs: { 
                        trackUri: trackUri, 
                        timestamp: new Date(), 
                        played: false, 
                        datePlayed: null, 
                        trackName: trackName, 
                        artistName: artistName, 
                        duration_ms: duration_ms 
                    } 
                } 
            }
        );

        console.log('Song ' + trackUri + ' added to ' + username + '\'s queue');
    } catch (err) {
        console.error('Error adding song to the user\'s queue:', err);
    }
}



async function queueOldestUnplayedSong(ws) {
    console.log('running queueOldestUnplayedSong()');
    const users = await db.collection('users').find().toArray();
    
    if(users.length === 0) {
        console.log('No users found');
        return;
    }

    let index = 0;
    let found = false;

    while (!found) {
        const user = users[index];
        const unplayedSongs = user.queuedSongs.filter(song => !song.played);

        if (unplayedSongs.length > 0) {
            const oldestUnplayedSong = unplayedSongs.reduce((prev, curr) => prev.timestamp < curr.timestamp ? prev : curr);

            console.log('User:', user.username, 'Oldest unplayed song:', oldestUnplayedSong);
            await addSongToSpotifyQueue(oldestUnplayedSong, user);
            found = true;
        }

        index = (index + 1) % users.length;
    }
}

async function getRoundRobinQueue(ws) {
    console.log('running getRoundRobinQueue()');
    let queue = [];
    let users = await db.collection('users').find().toArray();
    console.log('Getting round robin queue:');
    // console log each user
    // console.log(users);
    let anyUnplayedSongs = true;

    while (anyUnplayedSongs) {
        anyUnplayedSongs = false;

        for (const user of users) {
            const unplayedSongs = user.queuedSongs.filter(song => !song.played);
            if (unplayedSongs.length > 0) {
                anyUnplayedSongs = true;
                const oldestUnplayedSong = unplayedSongs.reduce((oldest, current) => {
                    return (new Date(oldest.timestamp) < new Date(current.timestamp)) ? oldest : current;
                });

                queue.push({
                    username: user.username,
                    song: oldestUnplayedSong
                });

                // Marking the song as "played" for this iteration
                oldestUnplayedSong.played = true;
            }
        }
    }

    return queue;
}

// async function roundRobinQueueSongs() {
//     console.log('Running roundRobinQueueSongs()');

//     let users = await db.collection('users').find().toArray();

//     for (const user of users) {
//         const unplayedSongs = user.queuedSongs.filter(song => !song.played);

//         if (unplayedSongs.length > 0) {
//             const oldestUnplayedSong = unplayedSongs[0]; // Get the oldest unplayed song
//             console.log('User:', user.username, 'Oldest unplayed song to be queued:', oldestUnplayedSong.trackName);

//             // Add the song to Spotify's queue and mark it as played
//             await addSongToSpotifyQueue(oldestUnplayedSong, user);
//             await markSongAsPlayed(user.username, oldestUnplayedSong.trackUri);

//             break; // Exit after queuing one song
//         }
//     }
// }

async function roundRobinQueueSongs() {
    console.log('Running roundRobinQueueSongs()');
    let users = await db.collection('users').find({ roundedRobin: false }).toArray();
    // exclued users without any queued songs
    users = users.filter(user => user.queuedSongs.length > 0);
    

    if (users.length === 0) {
        await db.collection('users').updateMany({}, { $set: { roundedRobin: false } });
        console.log('All users roundedRobin reset to false.');
        users = await db.collection('users').find({ roundedRobin: false }).toArray();
    }

    for (const user of users) {
        let oldestUnplayedSong = user.queuedSongs.filter(song => !song.played)
                                                 .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];

        if (!oldestUnplayedSong) {
            console.log('No unplayed songs for user:', user.username);
            // reset roundedRobin to false for all users
            // await db.collection('users').updateMany({}, { $set: { roundedRobin: false } });
            continue;
        }

        console.log('Selected User:', user.username, 'Oldest Unplayed Song:', oldestUnplayedSong);

        const queueSuccess = await addSongToSpotifyQueue(oldestUnplayedSong, user);
        if (queueSuccess) {
            // Update the song as played
            await db.collection('users').updateOne(
                { username: user.username, 'queuedSongs.trackUri': oldestUnplayedSong.trackUri },
                { $set: { 'queuedSongs.$.played': true, 'queuedSongs.$.datePlayed': new Date() } }
            );

            // Verify the update
            const updatedUser = await db.collection('users').findOne({ username: user.username });
            const updatedSong = updatedUser.queuedSongs.find(song => song.trackUri === oldestUnplayedSong.trackUri);
            console.log('Updated song status:', updatedSong);

            user.roundedRobin = true;
            await db.collection('users').updateOne({ _id: user._id }, { $set: user });
            return { user, song: oldestUnplayedSong };
        }
    }

    console.log('Processed all users. No unplayed songs left.');
}







////////////////////////////////////////////////////////////latest semi working
// async function roundRobinQueueSongs() {
//     console.log('Running roundRobinQueueSongs()');
//     let users = await db.collection('users').find({ roundedRobin: false }).toArray();

//     if (users.length === 0) {
//         await db.collection('users').updateMany({}, { $set: { roundedRobin: false } });
//         console.log('All users roundedRobin reset to false.');
//         users = await db.collection('users').find({ roundedRobin: false }).toArray();
//     }

//     for (const user of users) {
//         let oldestUnplayedSong = user.queuedSongs.filter(song => !song.played)
//                                                  .sort((a, b) => new Date(a.timestamp.$date) - new Date(b.timestamp.$date))[0];

//         if (!oldestUnplayedSong) {
//             console.log('No unplayed songs for user:', user.username);

//             // Add songs from playlists if no unplayed songs are found
//             const success = await addSongsFromPlaylistToQueue(user);
//             if (success) {
//                 oldestUnplayedSong = user.queuedSongs.filter(song => !song.played)
//                                                      .sort((a, b) => new Date(a.timestamp.$date) - new Date(b.timestamp.$date))[0];
//             } else {
//                 console.log('No playlists found or no songs added from playlist for user:', user.username);
//             }
//         }

//         if (oldestUnplayedSong) {
//             console.log('Selected User:', user.username, 'Oldest Unplayed Song:', oldestUnplayedSong);

//             const queueSuccess = await addSongToSpotifyQueue(oldestUnplayedSong, user);
//             if (queueSuccess) {
//                 await markSongAsPlayed(user.username, oldestUnplayedSong.trackUri);
//                 user.roundedRobin = true;
//                 await db.collection('users').updateOne({ _id: user._id }, { $set: user });
//                 return { user, song: oldestUnplayedSong };
//             }
//         }
//     }

//     console.log('Processed all users. No unplayed songs left.');
// }


// async function getNextRoundRobinUserAndSong() {
//     let users = await db.collection('users').find().sort({ roundedRobin: 1 }).toArray();

//     for (const user of users) {
//         let oldestUnplayedSong = user.queuedSongs.find(song => !song.played);

//         if (oldestUnplayedSong) {
//             await addSongToSpotifyQueue(oldestUnplayedSong, user);
//             await markSongAsPlayed(user.username, oldestUnplayedSong.trackUri);

//             // Update the user's roundedRobin property to the current timestamp
//             await db.collection('users').updateOne({ _id: user._id }, { $set: { roundedRobin: new Date() } });

//             console.log('Selected User:', user.username, 'Oldest Unplayed Song:', oldestUnplayedSong);
//             return { user, song: oldestUnplayedSong };
//         }
//     }

//     console.log('All users processed. No unplayed songs left.');
//     return null;
// }

async function addSongToSpotifyQueue(song, user) {
    const spotifyApiUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(song.trackUri)}`;
    try {
        const response = await fetch(spotifyApiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        });

        if (!response.ok) {
            console.error('Error adding track to Spotify queue:', await response.text());
            return false;
        }

        console.log(`Song ${song.trackName} added to Spotify queue for user ${user.username}`);
        return true;
    } catch (error) {
        console.error('Error in addSongToSpotifyQueue:', error);
        return false;
    }
}




// async function addSongToSpotifyQueue(song, user, ws) {
//     try {
//         const spotifyApiUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(song.trackUri)}`;
//         const response = await fetch(spotifyApiUrl, {
//             method: 'POST',
//             headers: { 'Authorization': `Bearer ${globalAccessToken}` }
//         });

//         if (!response.ok) {
//             const errorData = await response.json();
//             console.error('Error adding track to queue:', errorData);
//             ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'Error adding track to queue' }));
//             return;
//         }

//         // await markSongAsPlayed(user.username, song.trackUri);
//         // ws.send(JSON.stringify({ type: 'queue-update', status: 'added' }));
//     } catch (error) {
//         console.error('Error in addSongToSpotifyQueue:', error);
//         ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'An error occurred while adding the track to the queue.' }));
//     }
// }

// async function markSongAsPlayed(username, trackUri) {
//     await db.collection('users').updateOne(
//         { username: username, 'queuedSongs.trackUri': trackUri },
//         { $set: { 'queuedSongs.$.played': true, 'queuedSongs.$.datePlayed': new Date() } }
//     );
//     console.log('Marked song as played:', trackUri, 'for user:', username);
// }

async function addToUserQueue(trackUri, username, ws) {
    try {
        // console.log(username, 'is adding track to queue:', trackUri);
        const trackId = trackUri.split(':').pop();
        
        // Fetch song details to check its length
        const songDetails = await fetchSongDetails(trackId); // Implement this function to fetch song details from Spotify
        // console.log('songDetails', songDetails);
        if (songDetails.duration_ms > 480000) {
            ws.send(JSON.stringify({ type: 'queue-error', message: 'Song is longer than 8 minutes' }));
            return;
        }
        console.log(username, 'is adding track to queue:', trackId)
        // console.log('Adding to queue:', trackUri, songDetails.name, songDetails.artists[0].name, username);
        addSongToQueue(username, trackUri, songDetails.name, songDetails.artists[0].name, songDetails.duration_ms);
        // createUser(trackUri, songDetails.name, songDetails.artists[0].name, username);
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
        // const spotifyApiUrl = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`;
        // const response = await fetch(spotifyApiUrl, {
        //     method: 'POST',
        //     headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        // });

        // if (!response.ok) {
        //     const errorData = await response.json();
        //     console.error('Error adding track to queue:', errorData);
        //     ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'Error adding track to queue' }));
        // } else {
        //     // Add to custom queue
        //     // addToMyQueue({ trackId: trackId, trackUri: trackUri });
        //     ws.send(JSON.stringify({ type: 'queue-update', status: 'added' }));
        // }
    } catch (error) {
        console.error('Error in addToUserQueue:', error);
        ws.send(JSON.stringify({ type: 'queue-update', status: 'error', message: 'An error occurred while adding the track to the queue.' }));
    }
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

// fetch song analytics from https://api.spotify.com/v1/audio-analysis/{id}
async function fetchSongAnalysis(trackId) {
    console.log('fetching song analysis for trackId:', trackId);
    const url = `https://api.spotify.com/v1/audio-analysis/${trackId}`;
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${globalAccessToken}` }
    });
    if (!response.ok) {
        throw new Error('Failed to fetch song analytics');
    }
    // console.log('response is:', response);
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
            roundRobinQueueSongs();
            // getNextRoundRobinUserAndSong()

            await collection.insertOne(newTrackEntry);
            console.log('newTrackEntry:', newTrackEntry);
            updateSong(newTrackEntry, body.progress_ms);
            // console.log(`Track (${track.id}) has been logged`);
        } else {
            // updateSong(recentTrack, body.progress_ms);
            // console.log('Track is already in the database');
        }
    } catch (err) {
        if (err.message === 'Unexpected end of JSON input') {
            return;
        }
        console.error('Error in getCurrentPlayingTrack:', err);
        return;
    }
}

async function getPlaylistData(playlistUrl) {
    try {
        const urlParts = playlistUrl.split('/');
        const playlistIdPart = urlParts[urlParts.length - 1];
        const playlistId = playlistIdPart.split('?')[0];
        console.log('getPlaylistData:', playlistId);

        const playlistApiUrl = `https://api.spotify.com/v1/playlists/${playlistId}`;

        const response = await fetch(playlistApiUrl, {
            headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        });

        if (!response.ok) {
            console.error('Spotify API playlist error:', response.statusText);
            return [];
        }

        const data = await response.json();
        
        return data;
    } catch (err) {
        console.error('Error getting playlist data:', err);
        return [];
    }
}

async function handlePlaylistSubmission(data) {
    try {
        const { user, playlistName, tracks } = data;

        const standardizedUsername = user.trim().toLowerCase();

        const playlist = {
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
            }))
        };

        const userEntry = await db.collection('users').findOne({ username: standardizedUsername });

        if (userEntry) {
            await db.collection('users').updateOne(
                { username: standardizedUsername },
                { $addToSet: { playlists: playlist } }
            );
            console.log('Playlist added to user entry successfully');
        } else {
            const newUser = {
                username: standardizedUsername,
                roundedRobin: false,
                playlists: [playlist],
                queuedSongs: []
            };
            await db.collection('users').insertOne(newUser);
            console.log('New user entry with playlist created successfully');
        }
    } catch (err) {
        console.error('Error submitting playlist:', err);
    }
}





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
        
        res.redirect('/');
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

const refreshInterval = 20 * 60 * 1000;  // 55 minutes in milliseconds
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
