const instagram = require('instagram-private-api');
const Bluebird = require('bluebird');
const inquirer = require('inquirer');
const fs = require('fs');
const fetch = require('node-fetch');
const schedule = require('node-schedule');
const config = require('./config.json');

const downloadDir = 'download';

var ig;

var refreshStories;
var refreshPosts;
var refreshHighlights;

(async () => {
    const {igUser} = await inquirer.prompt([{
        type: 'input',
        name: 'igUser',
        message: 'Username:'
    }]);
    const {igPass} = await inquirer.prompt([{
        type: 'password',
        name: 'igPass',
        message: 'Password:'
    }]);
    ig = new instagram.IgApiClient();
    ig.state.generateDevice(igUser);
    await ig.qe.syncLoginExperiments();
    Bluebird.try(async () => {
        const auth = await ig.account.login(igUser, igPass);
        console.log('Logged in as', auth.username);
        console.log('\n');
    }).catch(instagram.IgCheckpointError, async () => {
        console.log(ig.state.checkpoint);
        await ig.challenge.auto(true);
        console.log(ig.state.checkpoint);
        const { code } = await inquirer.prompt([
            {
                type: 'input',
                name: 'code',
                message: 'Enter code',
            },
        ]);
        console.log(await ig.challenge.sendSecurityCode(code));
    }).catch(e => console.log('Could not resolve checkpoint:', e, e.stack)).then(async () => {
        refreshStories = schedule.scheduleJob(config.cron.stories, checkStories);
        refreshPosts = schedule.scheduleJob(config.cron.posts, checkPosts);
        refreshHighlights = schedule.scheduleJob(config.cron.highlights, checkHighlights);
        checkStories();
    });

})();

async function checkHighlights(fireDate){
    console.log('Checking highlights, scheduled for', fireDate);
    const accountsFollowing = await getAllFollowing();
    for(account of accountsFollowing){
        await handleAccountHighlights(account).catch(err => console.error(err));
    }
}

async function checkStories(fireDate){
    console.log('Checking stories, scheduled for', fireDate);
    const allStories = await getAllStories();
    for ({media_ids} of allStories) {
        await handleStory(media_ids).catch(err => console.error(err));
    }
}

async function checkPosts(fireDate){
    console.log('Checking posts, scheduled for', fireDate);
    const accountsFollowing = await getAllFollowing();
    for(account of accountsFollowing){
        await handleAccountPosts(account).catch(err => console.error(err));
    }
}

function handleAccountHighlights(account){
    return new Promise(async (resolve, reject) => {
        console.log('Gathering highlights from', account.username);

        const allHighlights = await getAllHighlights(account.pk).catch(err => reject(err));
        if(!allHighlights) return;

        const savedUserHighlights = await getSaved(account.pk, 'stories').catch(err => reject(err));
        for(mediaInfo of allHighlights){
            if(savedUserHighlights.includes(`${mediaInfo.pk}`)) continue;
            await saveUserFile(mediaInfo.user.pk, account.username, 'stories', mediaInfo.pk, 'info.json', JSON.stringify(mediaInfo, null, 4)).catch(err => reject(err));
            let media = await fetchMedia(mediaInfo);
            await saveUserFile(mediaInfo.user.pk, account.username, 'stories', mediaInfo.pk, media.filename, media.data).catch(err => reject(err));
            console.log('Downloaded highlight', mediaInfo.pk, 'from', account.username);
            await asyncDelay(config.delays.highlight);
        }
        await asyncDelay(config.delays.highlightsuser);
        resolve();
    });
}

function handleStory(media_ids){
    return new Promise(async (resolve, reject) => {
        for(media_id of media_ids){
            let mediaInfo = await ig.media.info(media_id).catch(err => reject(err));
            if(mediaInfo == undefined) continue;
            if(mediaInfo.items == undefined) continue;
            if(mediaInfo.items[0] == undefined) continue;
            mediaInfo = mediaInfo.items[0]
            let savedUserStories = await getSaved(mediaInfo.user.pk, 'stories').catch(err => reject(err));
            if(savedUserStories.includes(`${mediaInfo.pk}`)) continue;
            await saveUserFile(mediaInfo.user.pk, mediaInfo.user.username, 'stories', mediaInfo.pk, 'info.json', JSON.stringify(mediaInfo, null, 4)).catch(err => reject(err));
            let media = await fetchMedia(mediaInfo).catch(err => reject(err));
            await saveUserFile(mediaInfo.user.pk, mediaInfo.user.username, 'stories', mediaInfo.pk, media.filename, media.data).catch(err => reject(err));
            console.log('Downloaded story', mediaInfo.pk, 'from', mediaInfo.user.username);
            await asyncDelay(config.delays.story);
        }
        resolve();
    });
}

function handleAccountPosts(account){
    return new Promise(async (resolve, reject) => {
        console.log('Gathering posts from', account.username);

        savedPfps = await getSaved(account.pk, 'pfp').catch(err => reject(err));
        if(!savedPfps.includes(account.profile_pic_id + '.jpg')) if(account.profile_pic_id){
            const userInfo = await ig.user.info(account.pk).catch(err => console.error(err.name, err.message));
            if(userInfo){
                const pfpMedia = await fetchRawMedia(userInfo.hd_profile_pic_url_info.url);
                await saveUserFile(userInfo.pk, userInfo.username, 'pfp', false, userInfo.profile_pic_id + '.jpg', pfpMedia).catch(err => reject(err));
            }else console.log("Can't get profile info for", account.username, "so skipping pfp download");
        }

        const userPosts = await getAllPosts(account.pk).catch(err => reject(err));
        let savedPosts = await getSaved(account.pk, 'posts');

        switch(userPosts.length){
            case 0:
                console.log(account.username, 'has no posts');
                break;
            case 1:
                console.log('Saving', userPosts.length, 'post from', account.username);
                break;
            default:
                console.log('Saving', userPosts.length, 'posts from', account.username);
        }
        let postsLeft = userPosts.length;
        for(post of userPosts){
            if(savedPosts.includes(`${post.pk}`)) continue;
            
            process.stdout.cursorTo(0);
            if(postsLeft > 0) process.stdout.write('Posts left: ' + postsLeft);
            
            await saveUserFile(account.pk, account.username, 'posts', post.pk, 'info.json', JSON.stringify(post, null, 4)).catch(err => reject(err));

            if(post.image_versions2 != undefined){
                let postMedia = await fetchMedia(post);
                await saveUserFile(account.pk, account.username, 'posts', post.pk, postMedia.filename, postMedia.data).catch(err => reject(err));
            }else if(post.carousel_media != undefined){
                for(postPart of post.carousel_media){
                    let postMedia = await fetchMedia(postPart);
                    await saveUserFile(account.pk, account.username, 'posts', post.pk, postMedia.filename, postMedia.data).catch(err => reject(err));
                }
            }

            postsLeft--;
            await asyncDelay(config.delays.post);
            process.stdout.clearLine();
        }
        console.log();
        await asyncDelay(config.delays.postsuser);
        resolve();
    });
}

function getSaved(userPk, type){
    return new Promise(async (resolve, reject) => {
        const items = await fs.promises.readdir([downloadDir, userPk, type].join('/')).catch(err =>{
            if(err.code == 'ENOENT'){
                resolve([]);
            }else{
                reject(err);
            }
        });
        resolve(items);
    });
}

function saveUserFile(userPk, username, type, contentPk, filename, data){
    return new Promise(async (resolve, reject) => {
        if(contentPk){
            await fs.promises.mkdir([downloadDir, userPk, type, contentPk].join('/'), {recursive: true}).catch(err => reject(err));
            await fs.promises.writeFile([downloadDir, userPk, username].join('/'), '').catch(err => reject(err));
            await fs.promises.writeFile([downloadDir, userPk, type, contentPk, filename].join('/'), data).catch(err => reject(err));
        }else{
            await fs.promises.mkdir([downloadDir, userPk, type].join('/'), {recursive: true}).catch(err => reject(err));
            await fs.promises.writeFile([downloadDir, userPk, username].join('/'), '').catch(err => reject(err));
            await fs.promises.writeFile([downloadDir, userPk, type, filename].join('/'), data).catch(err => reject(err));
        }
        
        resolve();
    });
}

function getAllFollowing(pk){
    return new Promise((resolve, reject) => {
        const allFollowing = [];
        ig.feed.accountFollowing().items$.subscribe({
            next(currentFollowing) {
                allFollowing.push(...currentFollowing);
            },
            error(e) {
                reject(e);
            },
            complete() {
                resolve(allFollowing);
            },
        });
    });
}

function getAllPosts(pk){
    return new Promise((resolve, reject) => {
        const allPosts = [];
        ig.feed.user(pk).items$.subscribe({
            next(currentPosts) {
                allPosts.push(...currentPosts);
            },
            error(e) {
                reject(e);
            },
            complete() {
                resolve(allPosts);
            },
        });
    });
}

function getAllStories(){
    return new Promise((resolve, reject) => {
        const allStories = [];
        ig.feed.reelsTray().items$.subscribe({
            next(currentStory) {
                allStories.push(...currentStory);
            },
            error(e) {
                reject(e);
            },
            complete() {
                resolve(allStories);
            },
        });
    });
}

function getAllHighlights(pk){
    return new Promise(async (resolve, reject) => {
        const userHighlights = await ig.highlights.highlightsTray(pk).catch((reason)=>{
            reject(reason);
        });
        if(userHighlights.tray.length == 0) resolve([]);
        const highlightsMedia = await ig.feed.reelsMedia({userIds: userHighlights.tray.map(x => x.id)});
        const allHighlights = [];
        highlightsMedia.items$.subscribe({
            next(currentHighlight) {
                allHighlights.push(...currentHighlight);
            },
            error(e) {
                reject(e);
            },
            complete() {
                resolve(allHighlights);
            },
        });
    });
}

function fetchRawMedia(url){
    return new Promise(
        async (resolve, reject) => {
            const mediaResponse = await fetch(url, {
                headers: {
                    'Accept-Encoding': 'gzip',
                    'Connection': 'close',
                    'X-FB-HTTP-Engine': 'Liger',
                    'User-Agent': ig.state.appUserAgent
                },
                redirect: 'follow'
            }).catch(err => {
                if(err) reject(err);
            });
            const media = await mediaResponse.buffer().catch(err => {
                reject(err);
            });
            resolve(media);
        }
    );
}

function fetchMedia(media){
    var url;
    var filename;
    switch (media.media_type) {
        case 1:
            url = media.image_versions2.candidates[0].url;
            filename = media.pk + '.jpeg';
            break;
        case 2:
            url = media.video_versions[0].url;
            filename = media.pk + '.mp4';
            break;
        default:
            return;
    }
    return new Promise(
        async (resolve, reject) => {
            const media = await fetchRawMedia(url);
            resolve({filename: filename, data: media});
        }
    );
}

function asyncDelay(msecs){
    return new Promise((resolve)=>{
        setTimeout(resolve, msecs);
    });
}
