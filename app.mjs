import express from 'express';
import session from 'express-session';
import { MongoClient, ServerApiVersion } from "mongodb";
import fs from 'fs';
import { WebSocketServer } from 'ws';
import cookieParser from 'cookie-parser';

const { PORT, MONGODB, AUTH, OPENAI_API_KEY, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET } = process.env;
const client = new MongoClient(MONGODB, { serverApi: ServerApiVersion.v1 });
const redirect_uri = 'https://spotify.lucasfarmer.com/callback';

const app = express();
const server = app.listen(PORT, () => { console.log(`The NodeJS application is running on port ${PORT};`) });
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
    secret: 'bugEyedCat', // Replace 'your-secret-key' with a real secret string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: 'auto', httpOnly: false, maxAge: 12 * 60 * 60 * 1000 } // Expires in 12 hours
}));
app.use(cookieParser('bugEyedCat'));

app.set('view engine', 'pug');
app.set('views', './views');
app.locals.pretty = true;

const db = client.db('LFDEV');
const collection = db.collection('spotify_history');

const interval = 4000;
let globalAccessToken;
let globalRefreshToken;
let refreshIntervalId;
let appIsActive = false;
let allowExplicit = true;
let excludedArtists = [];
let maxDuration = 480000;

console.log('Starting Spotify app');

function authentication(req, res, next) {
	const authHeader = req.headers.authorization;
	if (!authHeader) {
		res.setHeader("WWW-Authenticate", "Basic");
		return res.sendStatus(401);
	};
	const auth = new Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":");
	if (auth[1] == AUTH) {
		next();
	} else {
		res.setHeader("WWW-Authenticate", "Basic");
		return res.sendStatus(401);
	};
};

app.get('/admin', authentication, async (req, res) => {
    const allUsers = await client.db('LFDEV').collection('users').find().toArray();
    // console.log('allUsers:', allUsers.length);
    const requestingUsers = allUsers.filter(user => !user.grantedAccess);
    // console.log('requestingUsers:', requestingUsers.length);

    const grantedUsers = allUsers.filter(user => user.grantedAccess)
    const grantedUsersCountTotalQueuedSongs = grantedUsers.reduce((total, user) => total + user.queuedSongs.length, 0);
    const totalUserCount = grantedUsers.length;
    // console.log('grantedUsers:', grantedUsers.length);
    // console.log('users:', allUsers[0]);
    // const tokenInfo = await client.db('LFDEV').collection('spotify_info').findOne({}, { sort: { _timestamp: -1 } });
    res.render('admin', { appIsActive, requestingUsers, grantedUsers , grantedUsersCountTotalQueuedSongs , totalUserCount });
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.get(['/', '/tracks'], async (req, res) => {
    // const user = req.session;
    // console.log(user);
    console.log('server Cookies:', req.cookies.username);
    const username = req.cookies.username;
    // console.log(username + ' grantedAccess:' + user.grantedAccess);
    if (!username) {
        res.redirect('/login');
        return;
    }
    const user = await client.db('LFDEV').collection('users').findOne({ username: username , grantedAccess: true });
    // console.log('user:', user);
    if (!user) {
        res.redirect('/login');
        return;
    } else {
        try {
            const page = parseInt(req.query.page) || 1;
            const pageSize = parseInt(req.query.pageSize) || 20;
            const totalTracks = await collection.countDocuments();
            const tracks = await collection.find({}).skip((page - 1) * pageSize).limit(pageSize).sort({_timestamp: -1}).toArray();
            const recentTrack = tracks[0];
            console.log('appIsActive:', appIsActive);
            res.render('tracks', { appIsActive, tracks, recentTrack, page, totalTracks, pageSize , user});
        } catch (err) {
            console.error(err);
            res.status(500).send('Server error');
        }
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
            case 'startApp':
                console.log('startApp');
                appIsActive = true;
                break;
            case 'stopApp':
                console.log('stopApp');
                appIsActive = false;
                break;
            case 'allowAccess':
                console.log('allowAccess for username:', data.username);
                const updateResult = await db.collection('users').updateOne({ username: data.username }, { $set: { grantedAccess: true } });
            
                if (updateResult.matchedCount === 0) {
                    console.log('User not found:', data.username);
                    // Handle scenario when user is not found
                } else if (updateResult.modifiedCount > 0) {
                    console.log('Access granted to user:', data.username);
                    ws.send(JSON.stringify({ type: 'accessUpdated', username: data.username, accessGranted: true }));
                } 
                break;
            case 'removeAccess':
                console.log('removeAccess for username:', data.username);
                const removeResult = await db.collection('users').updateOne({ username: data.username }, { $set: { grantedAccess: false } });
                break;
            case 'deleteUser':
                console.log('Deleting user:', data.username);
                const deleteResult = await db.collection('users').deleteOne({ username: data.username });
                break;
            case 'dump-tokens':
                console.log('Dumping tokens');
                await db.collection('spotify_info').deleteMany({});
                break;
            case 'dump-history':
                console.log('dumping history')
                await db.collection('spotify_history').deleteMany({});
                break;
            case 'get-user-queue':
                const userQueue = await getUserQueue(data.username);
                console.log('Sending user queue:', userQueue.length); // Log for debugging
                ws.send(JSON.stringify({ type: 'user-queue', queueItems: userQueue }));
                break;
            case 'resetPlayedSongs':
                // reset all users played songs to false
                console.log('resetting all users played songs to false');
                await db.collection('users').updateMany({}, { $set: { 'queuedSongs.$[].played': false } });
                // await db.collection('users').updateMany({}, { $set: { 'queuedSongs.$[].datePlayed': null } });
                break;
            case 'markAllPlayed':
                // mark all users played songs to true
                console.log('marking all users played songs to true');
                await db.collection('users').updateMany({}, { $set: { 'queuedSongs.$[].played': true } });
                break;
            // case 'fetch-song-analysis':
            //     console.log('fetch-song-analysis');
            //     // send song song-analysis
            //     const songAnalysis = await fetchSongAnalysis(data.trackId);
            //     ws.send(JSON.stringify({ type: 'song-analysis', songAnalytics }));
            //     break;
            case 'login':
                console.log('Login attempt:', data.realname, data.alias , data.csid);
                const user = await db.collection('spotifyUsers').findOne({ username: data.alias });
                if (!user) {
                    // Create a new record
                    // const newUser = { username: data.username };
                    createUser(data.realname, data.alias, data.csid, ws);
                    console.log('New user record created:', data.alias);
                }
                if (user) {
                    ws.send(JSON.stringify({ type: 'login-success', message: 'Login successful' }));
                } else {
                    ws.send(JSON.stringify({ type: 'login-error', message: 'Invalid username', username: data.alias }));
                }
                break;
            case 'search':
                console.log('username is:', data.username);
                console.log('searching for:', data.query);
                const searchResults = await searchSpotify(data.type, data.query, data.username, data.csid, ws);
                ws.send(JSON.stringify({ type: 'search-results', results: searchResults }));
                break;
            case 'add-to-queue':
                console.log('add-to-queue ' + data.trackUri + ' ' + data.csid);
                await addToUserQueue(data.trackUri, data.realname, data.username, data.csid, ws);
                // console.log(username, 'is adding track to queue:', data.trackUri);
                break;
            case 'remove-from-queue':
                console.log('remove-from-queue ' + data.trackUri + ' ' + data.username);
                await removeFromQueue(data.username, data.trackUri, ws);
                break;
            case 'get-queue':
                const virtualQueue = await getVirtualQueue();
                console.log('Sending virtualQueue to client:');
                // const realQueue = await getQueueData();
                // if (realQueue) {
                //     ws.send(JSON.stringify({ type: 'queue-data', queueItems: virtualQueue }));
                // } else {
                    ws.send(JSON.stringify({ type: 'queue-data', queueItems: virtualQueue }));
                // }
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
            case 'add-to-front-of-users-queue':
                // add song to user queue in place of oldest unplayed song and move all other songs down one
                console.log('add-to-front-of-users-queue');
                

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
            queuedBy: song.queuedBy,
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
        // const data = await response.json();
        // console.log('getQueueData response:', await response.json());
        // fs.writeFileSync('getQueueData.json', JSON.stringify(await response.json()));
        return await response.json();
    } catch (err) {
        console.error('Error in getQueueData:', err);
        return [];
    }
}


async function searchSpotify(type, query, username, csid, ws) {
    // confirm user exists and has accessGranted
    console.log(username, 'is searching for:', query);
    const user = await db.collection('users').findOne({ username: username });
    type = type || 'track';
    // console.log('user.grantedAccess:', user);
    // if (!user) {
    //     ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'User not found' }));
    //     createUser(username, csid, ws);
    //     return;
    // }
    // if(!user.grantedAccess) {
    //     ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'You do not have access to add songs to the queue.' }));
    //     return;
    // }
    console.log('type:', type);
    try {
        const spotifyApiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${(type)}&limit=50`;
        const response = await fetch(spotifyApiUrl, {
            headers: { 'Authorization': `Bearer ${globalAccessToken}` }
        });

        if (!response.ok) {
            console.error('Spotify API search error:', response.statusText);
            return [];
        } 

        const data = await response.json();
        const filteredExplicitItems = allowExplicit ? data.tracks.items : data.tracks.items.filter(item => !item.explicit);
        const filteredMaxDurationItems = filteredExplicitItems.filter(item => item.duration_ms <= maxDuration);
        const filteredItems = filteredExplicitItems.filter(item => !excludedArtists.includes(item.artists[0].name));
        console.log('searchSpotify response:', data);
        // if (type === 'track') {
        //     return data.tracks.items;
        // } else if (type === 'album') {
        //     return data.albums.items;
        // } else if (type === 'artist') {
        //     return data.artists.items;
        // }

        return filteredMaxDurationItems;
    } catch (err) {
        console.error('Error in searchSpotify:', err);
        return [];
    }
}

async function createUser(realname, username, csid, ws) {
    console.log('running createUser()');
    try {
        const db = client.db('LFDEV'); // Replace 'LFDEV' with your database name
        const collection = db.collection('users'); // Replace 'users' with your collection name

        // Create a unique index on the 'username' field
        await collection.createIndex({ username: 1 }, { unique: true });

        // Check if the username already exists
        const existingUser = await collection.findOne({ username: username });

        if (existingUser) {
            // Username already exists, send an error message back to the client
            ws.send(JSON.stringify({ type: 'user-created', username: username }));

            // ws.send(JSON.stringify({ type: 'user-creation-error', message: 'Username already exists' }));
        } else {
            // Proceed with user creation since the username is unique
            const userDocument = {
                csid: csid,
                username: username,
                realname: realname,
                pin: null,
                createdAt: new Date(),
                grantedAccess: false,
                roundedRobin: false,
                
                queuedSongs: []
            };

            // Insert the new user document into the collection
            await collection.insertOne(userDocument);
            
            // User created successfully, send a success message back to the client
            // ws.send(JSON.stringify({ type: 'user-created', username: username }));
        }
    } catch (err) {
        console.error('Error in createUser function:', err);
        // Send a generic error message back to the client
        ws.send(JSON.stringify({ type: 'user-creation-error', message: 'An error occurred during user creation' }));
    }
}

async function addSongToQueue(username, trackUri, trackName, artistName, duration_ms, ws) {
    console.log('running addSongToQueue()');
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
            if (typeof ws !== 'undefined' && typeof ws.send === 'function') {
                // ws.send(JSON.stringify({ type: 'queue-error', message: 'Song is already in the queue' }));
                ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'Song is already in the queue' }));
            }
            console.log('Song already exists in the queue for user:', username);
            return;
        }
        
        const queuePosition = userExists.queuedSongs.length + 1;
        console.log('queuePosition:', queuePosition);

        await db.collection('users').updateOne(
            { username: username },
            {
                $push: { 
                    queuedSongs: { 
                        trackUri: trackUri, 
                        timestamp: new Date(),
                        played: false,
                        datePlayed: null,
                        queued: false,
                        dateQueued: null,
                        queuePosition: queuePosition,
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

async function removeFromQueue(username, trackUri) {
    console.log('running removeSongFromQueue()');
    console.log(username);
    try {
        // Find the user
        const user = await db.collection('users').findOne({ username: username });

        if (!user) {
            console.log('User not found:', username);
            return;
        }

        // Find the index of the song in the queue
        const songIndex = user.queuedSongs.findIndex(song => song.trackUri === trackUri);

        if (songIndex === -1) {
            console.log('Song not found in the queue for user:', username);
            return;
        }

        // Remove the song from the queue
        user.queuedSongs.splice(songIndex, 1);

        // Update the user's document in the database
        await db.collection('users').updateOne(
            { username: username },
            { $set: { queuedSongs: user.queuedSongs } }
        );

        console.log('Song ' + trackUri + ' removed from ' + username + '\'s queue');
    } catch (err) {
        console.error('Error removing song from the user\'s queue:', err);
    }
}




// 2-1-24 kings working!!
// async function getVirtualQueue(ws) {
//     console.log('Running generateQueue()');
//     let users = await db.collection('users').find({ grantedAccess: true }).toArray();

//     // Exclude users without any queued songs or with all songs played
//     users = users.filter(user => user.queuedSongs.length > 0 && user.queuedSongs.some(song => !song.played));

//     if (users.length === 0) {
//         console.log('No more unplayed songs left for any user.');
//         return [];
//     }

//     // Sort each user's songs by queuePosition
//     users.forEach(user => {
//         user.queuedSongs.sort((a, b) => a.queuePosition - b.queuePosition);
//     });

//     // Interleave songs from each user
//     let queue = [];
//     let position = 0;
//     let added;

//     do {
//         added = false;
//         users.forEach(user => {
//             const userSongs = user.queuedSongs.filter(song => !song.played);
//             if (position < userSongs.length) {
//                 queue.push(userSongs[position]);
//                 added = true;
//             }
//         });
//         position++;
//     } while (added);

//     // Update database based on your logic for marking songs as queued or adjusting queue positions
//     // This part depends on your application's specific needs and database schema

//     console.log('Generated Final Queue:', queue);
//     return queue;
// }





async function getVirtualQueue(ws) {
        console.log('running getVirtualQueue()');
        let queue = [];
        // let users = await db.collection('users').find().toArray();
        let users = await db.collection('users').find({ grantedAccess: true }).toArray();
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
    console.log('queue lenght:', queue.length);
    return queue;
}

// async function nextSong() {
//     console.log('Running nextSong()');
//     let users = await db.collection('users').find({ roundedRobin: false, grantedAccess: true }).toArray();
    
//     // Exclude users without any queued songs
//     users = users.filter(user => user.queuedSongs.length > 0 && user.queuedSongs.some(song => !song.played));

//     if (users.length === 0) {
//         // Check if all users have roundedRobin set to true and have unplayed songs
//         const allRounded = await db.collection('users').find({ roundedRobin: true, 'queuedSongs.played': false }).count();
//         if (allRounded > 0) {
//             // Reset roundedRobin for all users
//             await db.collection('users').updateMany({}, { $set: { roundedRobin: false } });
//             console.log('All users roundedRobin reset to false.');
//             users = await db.collection('users').find({ roundedRobin: false }).toArray();
//         } else {
//             console.log('No more unplayed songs left for any user.');
//             return;
//         }
//     }

//     for (const user of users) {
//         let oldestUnplayedSong = user.queuedSongs.filter(song => !song.played)
//                                                  .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];

//         if (!oldestUnplayedSong) {
//             console.log('No unplayed songs for user:', user.username);
//             continue;
//         }

//         console.log('Selected User:', user.username, 'Oldest Unplayed Song:', oldestUnplayedSong);

//         const queueSuccess = await addSongToSpotifyQueue(oldestUnplayedSong, user);
//         if (queueSuccess) {
//             user.roundedRobin = true;
//             await db.collection('users').updateOne({ _id: user._id }, { $set: user });
        
//             await db.collection('users').updateOne(
//                 { username: user.username, 'queuedSongs.trackUri': oldestUnplayedSong.trackUri },
//                 { $set: { 'queuedSongs.$.played': true, 'queuedSongs.$.datePlayed': new Date() } }
//             );
        
//             const updatedUser = await db.collection('users').findOne({ username: user.username });
//             console.log('Updated song status:', updatedUser.queuedSongs.find(song => song.trackUri === oldestUnplayedSong.trackUri));
        
//             return { user, song: oldestUnplayedSong };
//         }
//     }

//     console.log('Processed all users.');
// }

async function nextSong() {
    console.log('Running nextSong()');
    let users = await db.collection('users').find({ roundedRobin: false, grantedAccess: true }).toArray();
    
    // Exclude users without any queued songs
    users = users.filter(user => user.queuedSongs.length > 0 && user.queuedSongs.some(song => !song.played));

    if (users.length === 0) {
        // Check if all users have roundedRobin set to true and have unplayed songs
        const allRounded = await db.collection('users').find({ roundedRobin: true, 'queuedSongs.played': false }).count();
        if (allRounded > 0) {
            // Reset roundedRobin for all users
            await db.collection('users').updateMany({}, { $set: { roundedRobin: false } });
            console.log('All users roundedRobin reset to false.');
            users = await db.collection('users').find({ roundedRobin: false }).toArray();
        } else {
            console.log('No more unplayed songs left for any user.');
            return;
        }
    }

    for (const user of users) {
        let oldestUnplayedSong = user.queuedSongs.filter(song => !song.played)
                                                 .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))[0];

        if (!oldestUnplayedSong) {
            console.log('No unplayed songs for user:', user.username);
            continue;
        }

        console.log('Selected User:', user.username, 'Oldest Unplayed Song:', oldestUnplayedSong);

        const queueSuccess = await addSongToSpotifyQueue(oldestUnplayedSong, user);
        if (queueSuccess) {
            user.roundedRobin = true;
            await db.collection('users').updateOne({ _id: user._id }, { $set: user });
        
            await db.collection('users').updateOne(
                { username: user.username, 'queuedSongs.trackUri': oldestUnplayedSong.trackUri },
                { $set: { 'queuedSongs.$.queued': true, 'queuedSongs.$.dateQueued': new Date() } }
            );
        
            const updatedUser = await db.collection('users').findOne({ username: user.username });
            console.log('Updated song status:', updatedUser.queuedSongs.find(song => song.trackUri === oldestUnplayedSong.trackUri));
        
            return { user, song: oldestUnplayedSong };
        }
    }

    console.log('Processed all users.');
}

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

async function addToUserQueue(trackUri, realname, username, csid, ws) {
    console.log('running addToUserQueue() username is:', username);

    // const user = await db.collection('users').findOne({ username: username });
    const user = await db.collection('users').findOne({ username: username });
    if (!user) {
        // ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'User not found' }));
        console.log('User not found while running addToUserQueue(). Creating user:', username);
        createUser(realname, username, csid, ws);
        // return;
    }

    // console.log('user.grantedAccess:', user);
    // if(!user.grantedAccess) {
    //     ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'You do not have access to add songs to the queue.' }));
    //     return;
    // }
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

        // Check if song is already in the current Spotify queue
        const currentQueue = await getQueueData();
        // console.log('currentQueue', currentQueue.queue[0].id);

        if (currentQueue.queue && currentQueue.queue.some(queue => queue.id === trackId)) {
            ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'Song is already in the queue' }));
            return;
        }

        // Check if song is already in the virtual queue
        const virtualQueue = await getVirtualQueue();
        if (virtualQueue.some(queue => queue.song.trackId === trackId)) {
            ws.send(JSON.stringify({ type: 'queue-error', status: 'error', message: 'Song is already in the queue' }));
            // console.log('Song is already in the queue');
            return;
        }

        // Check if song has been played in the last 12 hours
        const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).getTime();
        const recentPlay = await db.collection('spotify_history').findOne({
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
        addSongToQueue(username, trackUri, songDetails.name, songDetails.artists[0].name, songDetails.duration_ms);

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
            // match up the current track with the user who added it to the queue
            const user = await db.collection('users').findOne({ 'queuedSongs.trackUri': track.uri });
            if (user) {
                const songIndex = user.queuedSongs.findIndex(song => song.trackUri === track.uri);
                if (songIndex !== -1) {
                    user.queuedSongs[songIndex].played = true;
                    user.queuedSongs[songIndex].datePlayed = new Date();
                    await db.collection('users').updateOne({ _id: user._id }, { $set: user });
                }
                const updatedUser = await db.collection('users').findOne({ _id: user._id });
                console.log('username current song:', updatedUser.username);
            }

            const newTrackEntry = {
                _timestamp: Date.now(),
                queuedBy: user ? user.username : null,
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
            
            // getNextRoundRobinUserAndSong()
            
            await collection.insertOne(newTrackEntry);
            console.log('New track entered into history:', newTrackEntry);
            updateSong(newTrackEntry, body.progress_ms);
            // console.log(`Track (${track.id}) has been logged`);

            // conditional for adding to queue
            if (appIsActive) {
                nextSong();
            }
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
app.get('/auth', (req, res) => {
    const scope = 'user-read-email user-read-private user-read-currently-playing user-read-recently-played user-modify-playback-state user-read-playback-state';
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
