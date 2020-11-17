const instagram = require('instagram-private-api');
const Bluebird = require('bluebird');
const inquirer = require('inquirer');
const fs = require('fs');
const fetch = require('node-fetch');
const schedule = require('node-schedule');
const cron = require('./cron.json');

if (!fs.existsSync('download/')) fs.mkdirSync('download');

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
        refreshStories = schedule.scheduleJob(cron.stories, checkStories);
        refreshPosts = schedule.scheduleJob(cron.posts, checkPosts);
        refreshHighlights = schedule.scheduleJob(cron.highlights, checkHighlights);
    });

})();


async function checkHighlights(fireDate){
    console.log('Checking highlights, scheduled for', fireDate);
    const accountsFollowing = await getAllFollowing();
    for(account of accountsFollowing){
        console.log('Gathering highlights from', account.username);

        await fs.promises.mkdir(`download/${account.pk}`, {recursive: true}).catch(err => {return});
        await fs.promises.writeFile(`download/${account.pk}/${account.username}`, '').catch(err => {return});

        var allHighlights = undefined;
        var errorCount = 0;
        while(allHighlights == undefined){
            allHighlights = await getAllHighlights(account.pk).catch(err => {
                console.error('Error getting highlights for', account.username, ':\n', err);
                errorCount++;
            });
            if(errorCount > 3) break;
            if(allHighlights == undefined) await asyncDelay(errorCount*60000);
        }
        if(errorCount > 3){
            console.error("Too many errors getting highlights from", account.username);
            break;
        }

        for (mediaInfo of allHighlights) {
            await fs.promises.mkdir(`download/${mediaInfo.user.pk}/stories/`, {recursive: true}).catch(err => {return});
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/${account.username}`, '').catch(err => {return});
            let savedUserHighlights = await fs.promises.readdir(`download/${mediaInfo.user.pk}/stories/`);
            if(savedUserHighlights.includes(`${mediaInfo.pk}`)) continue;
            await fs.promises.mkdir(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/`, {recursive: true}).catch(err => {return});
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/info.json`, JSON.stringify(mediaInfo, null, 4)).catch(err => {console.error(err)});
            let media = await fetchMedia(mediaInfo);
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/${media.filename}`, media.data).catch(err => {console.error(err)});
            console.log('Downloaded highlight', mediaInfo.pk, 'from', account.username);
        }
    }
}

async function checkStories(fireDate){
    console.log('Checking stories, scheduled for', fireDate);
    const allStories = await getAllStories();
    for ({media_ids} of allStories) {
        for(media_id of media_ids){
            let mediaInfo = await ig.media.info(media_id);
            if(mediaInfo == undefined) continue;
            if(mediaInfo.items == undefined) continue;
            if(mediaInfo.items[0] == undefined) continue;
            mediaInfo = mediaInfo.items[0]
            await fs.promises.mkdir(`download/${mediaInfo.user.pk}/stories/`, {recursive: true}).catch(err => {return});
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/${mediaInfo.user.username}`, '').catch(err => {return});
            let savedUserStories = await fs.promises.readdir(`download/${mediaInfo.user.pk}/stories/`);
            if(savedUserStories.includes(`${mediaInfo.pk}`)) continue;
            await fs.promises.mkdir(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/`, {recursive: true}).catch(err => {return});
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/info.json`, JSON.stringify(mediaInfo, null, 4)).catch(err => {console.error(err)});
            let media = await fetchMedia(mediaInfo);
            await fs.promises.writeFile(`download/${mediaInfo.user.pk}/stories/${mediaInfo.pk}/${media.filename}`, media.data).catch(err => {console.error(err)});
            console.log('Downloaded story', mediaInfo.pk, 'from', mediaInfo.user.username);
        }
    }
}

async function checkPosts(fireDate){
    console.log('Checking posts, scheduled for', fireDate);
    const accountsFollowing = await getAllFollowing();
    for(account of accountsFollowing){
        await fs.promises.mkdir(`download/${account.pk}/posts/`, {recursive: true}).catch(err => {return});
        await fs.promises.writeFile(`download/${account.pk}/${account.username}`, '').catch(err => {return});

        console.log('Gathering posts from', account.username);
        var userInfo = undefined;
        var errorCount = 0;
        while(userInfo == undefined){
            userInfo = await ig.user.info(account.pk).catch(function(err){
                console.error('Error getting profile picture for', account.username);
                errorCount++;
            });
            if(errorCount > 3){
                console.error("Too many errors getting profile picture for", account.username);
                break;
            }
            if(userInfo == undefined) await asyncDelay(errorCount*60000+60000);
        }


        if(userInfo != undefined) if(account.pk == userInfo.pk && userInfo.hd_profile_pic_url_info != undefined){
            const pfpSaved = await fs.promises.readFile(`download/${account.pk}/${userInfo.profile_pic_id}.jpg`).catch(err => {});
            if(pfpSaved == undefined){
                const pfpMedia = await fetchRawMedia(userInfo.hd_profile_pic_url_info.url);
                await fs.promises.writeFile(`download/${account.pk}/${userInfo.profile_pic_id}.jpg`, pfpMedia).catch(err => {});
            }
        }

        var userPosts = undefined;
        userPosts = await getAllPosts(account.pk).catch(err => {
            console.error('Error getting posts for', account.username);
        });
        let savedPosts = await fs.promises.readdir(`download/${account.pk}/posts/`);

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
            process.stdout.cursorTo(0);
            if(postsLeft > 0) process.stdout.write('Posts left: ' + postsLeft);
            if(!savedPosts.includes(`${post.pk}`)){
                await fs.promises.mkdir(`download/${account.pk}/posts/${post.pk}/`, {recursive: true}).catch(err => {return});
                await fs.promises.writeFile(`download/${account.pk}/posts/${post.pk}/info.json`, JSON.stringify(post, null, 4)).catch(err => {console.error(err)});
                if(post.image_versions2 != undefined){
                    let postMedia = await fetchMedia(post);
                    await fs.promises.writeFile(`download/${account.pk}/posts/${post.pk}/${postMedia.filename}`, postMedia.data).catch(err => {console.error(err)});
                }else if(post.carousel_media != undefined){
                    for(postPart of post.carousel_media){
                        let postMedia = await fetchMedia(postPart);
                        await fs.promises.writeFile(`download/${account.pk}/posts/${post.pk}/${postMedia.filename}`, postMedia.data).catch(err => {console.error(err)});
                    }
                }
            }
            postsLeft--;
            process.stdout.clearLine();
        }
        console.log();
    }
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
