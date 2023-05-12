const TelegramBot = require('node-telegram-bot-api');
const redisService = require("./redis.service")
const axios = require("axios")

const token = process.env.TELEGRAM_BOT_TOKEN;

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
            'account-id': '6f9957bb5843/46984c32-bba7-44c0-b2e2-b6ac83a56cfb',
            'api-key': '93fda054-47ca-49ef-bfc0-bc8360846fe0'
        },
        data: data
    };
}

const bot = new TelegramBot(token);

bot.on('message', async (message) => {
    const chatId = message.chat.id.toString()
    const fp = new FlowParser(flow)

    if (message.text === "/start") {
        const context = { chatId, stage: 0, tries: 3 }
        redisService.set(chatId, JSON.stringify(context), 15 * 60 * 1000)
        await fp.execute(message, context)
    } else {
        const exists = await redisService.exists(chatId)
        if (!exists) {
            await bot.sendMessage(chatId, "Sorry I can't remember our conversation, how about we start a new one? please send /start to begin your onboarding journey")
        } else {
            const ctx_ = await redisService.get(chatId)
            const context = JSON.parse(ctx_)
            await fp.execute(message, context)
        }
    }
});

bot.startPolling();



const flow = [
    {
        type: "message",
        text: "welcome to our customer onboarding journey!"
    },
    {
        type: "message",
        text: "please tell me your name"
    },
    {
        type: "input",
        expect: "string",
        propName: "name"
    },
    {
        type: "message",
        text: "Hi {{name}}, now send me picture of your PAN card"
    },
    {
        type: "input",
        expect: "image",
        propName: "pan"
    },
    {
        type: "message",
        text: "amazing! now just one final step"
    },
    {
        type: "message",
        text: "please send me your selfie :)"
    },
    {
        type: "input",
        expect: "image",
        propName: "selfie"
    },
    {
        type: "message",
        text: "Thank you, please wait while we verify your request"
    },
    {
        type: "verify_doc",
        verify: "ind_pan",
        src: "pan"
    },
    {
        type: "face_match",
        src1: "pan",
        src2: "selfie"
    },
    {
        type: "message",
        text: "hey {{name}}, your verification is successful!"
    }
]

class FlowParser {
    constructor(flow) {
        this.flow = flow
    }

    async execute(message, context) {
        if (context.tries <= 0) {
            await bot.sendMessage(context.chatId, "I regret to inform you that you've exceeded the number of unsuccessful tries, please try again later")
            await redisService.delete(context.chatId)
            return
        }

        if (context.stage >= this.flow.length) {
            await bot.sendMessage(context.chatId, "hey your verification is already completed")
            return
        }

        const stage = this.flow[context.stage];
        console.log("stage", stage)
        const mehodName = `execute_${stage.type}`;
        const method = this[mehodName]
        await method.call(this, stage, message, context);
    }

    async execute_message(stage, message, context) {
        await bot.sendMessage(context.chatId, stage.text.replace(/{{(.*?)}}/g, (_, placeholder) => context[placeholder]))
        context.stage++;
        redisService.set(context.chatId, JSON.stringify(context))
        if (["message", "verify_doc", "face_match"].includes(this.flow[context.stage]?.type))
            await this.execute(message, context)
    }

    async execute_input(stage, message, context) {
        const expect = stage.expect
        let passed = true
        if (expect === "string") {
            if (message.text) {
                context[stage.propName] = message.text;
            } else {
                await bot.sendMessage(context.chatId, "hmm.. I expected a text message")
                context.tries--;
                passed = false
            }
        } else if (expect === "image") {
            if (message.photo) {
                context[stage.propName] = message.photo[message.photo.length - 1].file_id
            } else {
                await bot.sendMessage(context.chatId, "hmm.. I expected a photo")
                context.tries--;
                passed = false
            }
        }
        if (passed) {
            context.stage++;
            redisService.set(context.chatId, JSON.stringify(context), 15 * 60 * 1000)
            return await this.execute(message, context)
        }
        redisService.set(context.chatId, JSON.stringify(context), 15 * 60 * 1000)
    }

    async execute_verify_doc(stage, message, context) {
        const src = context[stage.src]
        let data, res;
        try {
            const url = await retryFetch(getImageURL, 100, 3)(src)
            if (stage.verify === "ind_pan") {
                data = JSON.stringify({
                    "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                    "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                    "data": {
                        "document1": url,
                        "doc_type": "ind_pan",
                        "advanced_features": {
                            "detect_doc_side": false
                        }
                    }
                });


                res = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/validate/document', "post", data)).then(response => response.data), 100, 3)()

                if (res?.result.detected_doc_type !== 'ind_pan') {
                    await verificationFailed(context.chatId, "Provided pan is invalid, please restart the process")
                    return
                }

                data = JSON.stringify({
                    "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                    "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                    "data": {
                        "document1": url
                    }
                });

                res = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/extract/ind_pan', "post", data)).then(response => response.data), 100, 3)()

                const panNoOnCard = res.result.extraction_output.id_number

                data = JSON.stringify({
                    "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                    "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                    "data": {
                        "id_number": panNoOnCard
                    }
                });

                const { request_id } = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/async/verify_with_source/ind_pan', "post", data)).then(response => response.data), 100, 3)()

                await wait(3000)

                res = await retryFetch(() => axios.request(getConfig(`https://eve.idfystaging.com/v3/tasks?request_id=${request_id}`, "get")), 100, 5)()


                const isvalid = res.data[0].result.source_output.status === "id_found"

                if (!isvalid) {
                    await verificationFailed(context.chatId, "invalid pan id")
                    return
                }

                context.stage++;
                redisService.set(context.chatId, JSON.stringify(context))
                await this.execute(message, context)
            }
        } catch (error) {
            console.log(error)
            await bot.sendMessage(context.chatId, "Something went wrong, please try again later")
        }

    }

    async execute_face_match(stage, message, context) {
        try {
            const [src1, src2] = await Promise.all([
                retryFetch(getImageURL, 100, 3)(context[stage.src1]),
                retryFetch(getImageURL, 100, 3)(context[stage.src2])])

            const data = JSON.stringify({
                "task_id": "74f4c926-250c-43ca-9c53-453e87ceacd1",
                "group_id": "8e16424a-58fc-4ba4-ab20-5bc8e7c3c41e",
                "data": {
                    "document1": src1,
                    "document2": src2
                }
            });

            const res = await retryFetch(() => axios.request(getConfig('https://eve.idfystaging.com/v3/tasks/sync/compare/face', "post", data)).then(response => response.data), 100, 3)()

            if (!res.result.is_a_match) {
                await verificationFailed(context.chatId, "face matching failed, please restart your journey")
                return
            }

            context.stage++;
            redisService.set(context.chatId, JSON.stringify(context))
            await this.execute(message, context)
        } catch (error) {
            console.log(error)
            await bot.sendMessage(context.chatId, "Something went wrong, please try again later")
        }

    }
}
