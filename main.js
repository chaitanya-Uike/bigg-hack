const TelegramBot = require('node-telegram-bot-api');
const redisService = require("./redis.service")
const axios = require("axios")

const token = process.env.TELEGRAM_BOT_TOKEN;

const states = {
    "INTRO": "intro",
    "UPLOAD_PAN_CARD": "upload pan card",
    "UPLOAD_SELFIE": "upload selfie",
    "CONFIRMATION": "confirmation",
    "COMPLETED": "completed",
}

const transitions = {
    [states.INTRO]: states.UPLOAD_PAN_CARD,
    [states.UPLOAD_PAN_CARD]: states.UPLOAD_SELFIE,
    [states.UPLOAD_SELFIE]: states.CONFIRMATION,
    [states.CONFIRMATION]: null
}

function wait(delay) {
    return new Promise((resolve) => setTimeout(resolve, delay));
}

function retryFetch(fn, backoff, tries) {
    return (...args) => {
        async function onError(error) {
            console.log("--error", error)
            if (!tries--)
                throw error;
            await wait(backoff);
            return retryFetch(fn, backoff * 2, tries)()
        }
        try {
            return fn(...args)
        } catch (error) {
            return onError(error)
        }
    }
}

async function getImageURL(img_id) {
    const response = await axios.get(`https://api.telegram.org/bot${token}/getFile?file_id=${img_id}`)
    const filePath = response.data.result.file_path;
    const fileURL = `https://api.telegram.org/file/bot${token}/${filePath}`;

    return fileURL
}

async function verificationFailed(chatId, message) {
    await bot.sendMessage(chatId, message)
    await redisService.delete(chatId)
}

function getConfig(url, method, data) {
    return {
        method: method,
        maxBodyLength: Infinity,
        url: url,
        headers: {
            'Content-Type': 'application/json',
            'account-id': 'ef447697ea80/04c7eeab-ae9e-4826-bc1b-d85fddae1a36',
            'api-key': '30545c43-dbc5-4ff8-afa2-b1b407af86ac'
        },
        data: data
    };
}


async function verifyInfo(context, chatId) {
    const { selfie, pan } = context
    try {
        const [panURL, selfieURL] = await Promise.all([
            retryFetch(getImageURL, 100, 3)(pan),
            retryFetch(getImageURL, 100, 3)(selfie)])

        // 1) check if pan is actually pan
        try {
            let data = JSON.stringify({
                "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                "data": {
                    "document1": panURL,
                    "doc_type": "ind_pan",
                    "advanced_features": {
                        "detect_doc_side": false
                    }
                }
            });


            const panCheck = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/validate/document', "post", data)).then(response => response.data), 100, 3)()

            if (panCheck?.result.detected_doc_type !== 'ind_pan') {
                await verificationFailed(chatId, "Provided pan is invalid, please restart the process")
                return
            }

            data = JSON.stringify({
                "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                "data": {
                    "document1": panURL
                }
            });

            const panOCR = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/extract/ind_pan', "post", data)).then(response => response.data), 100, 3)()

            // const nameOnCard = panOCR.result.extraction.name_on_card
            const panNoOnCard = panOCR.result.extraction_output.id_number

            data = JSON.stringify({
                "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                "data": {
                    "id_number": panNoOnCard
                }
            });

            const { request_id } = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/async/verify_with_source/ind_pan', "post", data)).then(response => response.data), 100, 3)()

            await wait(3000)


            let res = await retryFetch(() => axios.request(getConfig(`https://eve.idfystaging.com/v3/tasks?request_id=${request_id}`, "get")), 100, 5)()

            const isvalid = res.data[0].result.source_output.status === "id_found"

            if (!isvalid) {
                await verificationFailed(chatId, "invalid pan id")
                return
            }

            data = JSON.stringify({
                "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                "data": {
                    "document1": panURL,
                    "document2": selfieURL
                }
            });

            res = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/compare/face', "post", data)).then(response => response.data), 100, 3)()

            if (!res.result.is_a_match) {
                await verificationFailed(chatId, "face matching failed, please restart your journey")
                return
            }

            bot.sendMessage(chatId, "verification successful, thank you")
            context.state = states.COMPLETED
            redisService.set(chatId, JSON.stringify(context))
        } catch (error) {
            console.log(error)
            await bot.sendMessage(chatId, "Something went wrong, please try again later")
        }


        // 2) get ocr data and comapare with name

        // 3) face match pan and selfie

    } catch (error) {
        console.log(error)
    }
}

const bot = new TelegramBot(token);

bot.on('message', async (message) => {
    const chatId = message.chat.id.toString()

    // first time conversation
    if (message.text === "/start") {
        const context = { state: states.INTRO, tries: 3 }
        redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
        await bot.sendMessage(chatId, 'Welcome to our customer onboarding journey!');
        await bot.sendMessage(chatId, "please tell me your name")
    } else {
        const exists = await redisService.exists(chatId)
        if (!exists) {
            await bot.sendMessage(chatId, "Sorry I can't remember our conversation, how about we start a new one? please send /start to begin your onboarding journey")
        } else {
            const ctx_ = await redisService.get(chatId)
            const context = JSON.parse(ctx_)
            const state = context.state || states.INTRO
            const nextState = transitions[state]

            if (context.tries <= 0) {
                await bot.sendMessage(chatId, "I regret to inform you that you've exceeded the number of unsuccessful tries, please try again later")
                await redisService.delete(chatId)
                return
            }

            if (state === states.INTRO) {
                if (message.text) {
                    const name = message.text
                    context.name = name
                    context.state = nextState
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                    await bot.sendMessage(chatId, `Hi ${name}, now send me a picture of your PAN card`)
                } else {
                    await bot.sendMessage(chatId, "hmm.. I expected a text message")
                    context.tries--;
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                }
            } else if (state === states.UPLOAD_PAN_CARD) {
                if (message.photo) {
                    context.pan = message.photo[message.photo.length - 1].file_id
                    context.state = nextState
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                    await bot.sendMessage(chatId, "amazing! now just one final step")
                    await bot.sendMessage(chatId, "please send me your selfie :)")
                } else {
                    await bot.sendMessage(chatId, "hmm.. I expected a photo")
                    context.tries--;
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                }
            } else if (state === states.UPLOAD_SELFIE) {
                if (message.photo) {
                    context.selfie = message.photo[message.photo.length - 1].file_id
                    context.state = nextState
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                    await bot.sendMessage(chatId, "Thank you, please wait while we verify your request")
                    verifyInfo(context, chatId)
                } else {
                    await bot.sendMessage(chatId, "hmm.. I expected a photo")
                    context.tries--;
                    redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
                }
            } else if (state === states.CONFIRMATION) {
                await bot.sendMessage(chatId, "please wait while we verify your information")
            }
            else if (state === states.COMPLETED) {
                await bot.sendMessage(chatId, "hey your verification is already completed")
            }
        }
    }
});

bot.startPolling();
