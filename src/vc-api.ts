import { Application, Request } from 'express'
import { randomBytes, randomUUID } from 'node:crypto'
import { Server } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import z from 'zod'

import { AudioMetadataBackend, ProcessorBackend, STTBackend, TTSBackend } from './backend/backend'
import { convertContentPrivacyConfig, convertGeneralConfig, convertNightModeConfig, convertSafeModeConfig, convertSpotifyConfig, convertStereoConfig, convertTelegramConfig, convertVkCallsConfig } from './config'
import { Dialog, DialogResult } from './dialog'
import { Directive } from './directives'
import { getEnvironment } from './environment'
import { getLogger } from './logger'
import { getBoundary, parse } from './multipart'
import { DeviceInfo, DeviceStorage } from './storage/database'
import { getDefaultDeviceConfig } from './storage/defaults'
import { RequestDeviceInfo } from './types'

enum VCConnectionMessageType {
  ACK = 1,
  NAK = 2,
  UPDATE_CONFIG = 8,
  COMMAND_CONTROL = 10
}

const FIRMWARE_VERSION = '44.90'

interface VCApiBackends {
  audioMetadata: AudioMetadataBackend,
  processor: ProcessorBackend,
  stt: STTBackend,
  tts: TTSBackend,
}

interface VCRouter {
  connections: Set<VCConnection>
}

export class VCConnection {
  private readonly logger = getLogger()

  constructor (private readonly webSocket: WebSocket, readonly deviceId: string,
    private readonly backends: VCApiBackends, private readonly streamStorage: Map<string, Buffer>,
    private readonly eventIdToTextMap: Map<string, string>) {
    this.webSocket.addEventListener('message', message => {
      this.logger.debug(`received WS message: ${JSON.stringify(message.data)}`)
    })
  }

  async pushEvent (text: string): Promise<void> {
    const id = randomUUID()
    this.eventIdToTextMap.set(id, text)
    await this.pushRawDirective({
      text: id,
      type: 'send_text'
    })
  }

  async pushRawDirective (command?: unknown, control?: unknown): Promise<void> {
    await this.send(VCConnectionMessageType.COMMAND_CONTROL, {
      commands: command ? [command] : [],
      controls: control ? [control] : [],
      skill: 'push'
    })
  }

  async pushTts (text: string): Promise<void> {
    if (!text) {
      return
    }
    const result = await this.backends.tts.synthesize({
      text
    })
    const streamId = randomUUID()
    this.streamStorage.set(streamId, result.voiceOutput)
    await this.pushRawDirective({
      blocking: false,
      encoder: 'opus',
      encoder_bitrate: null,
      encoder_frame_size: null,
      force_say: false,
      kws_skip: null,
      long_reader_request: false,
      model_name: 'tts',
      normalize: true,
      speed: 1,
      stream_hls: false,
      stream_id: streamId,
      text,
      type: 'tts'
    })
  }

  async updateConfig (): Promise<void> {
    await this.send(VCConnectionMessageType.UPDATE_CONFIG)
  }

  private async send (type: VCConnectionMessageType, data?: unknown): Promise<void> {
    this.logger.debug(`sending to WS: ${type} ${JSON.stringify(data)}`)
    const body = data ? Buffer.from(JSON.stringify(data), 'utf8') : Buffer.from([])
    const message = Buffer.alloc(32)
    message.writeUInt32BE(type, 0)
    message.writeUInt32BE(body.length, 4)
    randomBytes(16).copy(message, 16)
    return new Promise((resolve, reject) => {
      this.webSocket.send(Buffer.concat([message, body]), {
        binary: true
      }, error => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })
  }
}

export function registerVCApiRoutes (app: Application, server: Server,
  storage: DeviceStorage, backends: VCApiBackends): VCRouter {
  const logger = getLogger()
  const environment = getEnvironment()

  // AUTH_MODE=enforce: все vc-запросы (кроме attach_xtoken — это вход) требуют
  // Bearer <session_secret>, выданный при /account/attach_xtoken. Fail-closed:
  // пустой/неверный секрет → 401. Формат ошибки — по образцу облака (дамп 22.11).
  if (environment.AUTH_MODE === 'enforce') {
    app.use((request, response, next) => {
      if (request.path === '/account/attach_xtoken' || !request.deviceInfo) {
        next()
        return
      }

      storage.getOrCreate(request.deviceInfo.deviceId, getDefaultDeviceConfig())
        .then(device => {
          const expectedSecret = device.config.auth.sessionSecret
          if (expectedSecret && request.headers.authorization === `Bearer ${expectedSecret}`) {
            next()
            return
          }

          response.status(401).json({
            code: 401,
            error: '401:Unauthorized',
            qid: generateQueryId(),
            reason: 'Invalid or missing session secret'
          })
        })
        .catch(error => {
          logger.error('failed to check auth: ', error)
          response.status(500).end()
        })
    })
  }

  app.post('/account/attach_xtoken', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const xtokenId = request.query['xtoken_id']
      ? String(Array.isArray(request.query['xtoken_id'])
        ? request.query['xtoken_id'][0]
        : request.query['xtoken_id'])
      : ''

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        if (!device.config.auth.accountId) {
          device.config.auth.accountId = randomUUID()
        }
        device.config.auth.sessionSecret = randomBytes(32).toString('base64url')
        device.config.auth.xtokenId = xtokenId
        device.config.auth.attachedAt = Date.now()

        return storage.saveConfig(device).then(() => {
          response.status(200).json({
            qid: generateQueryId(),
            result: {
              account_id: device.config.auth.accountId,
              coordinates: '',
              session_id: randomUUID(),
              session_secret: device.config.auth.sessionSecret
            }
          })
        })
      })
      .catch(error => {
        logger.error('failed to attach xtoken: ', error)
        response.status(500).end()
      })
  })

  app.get('/account/info', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        response.status(200).json({
          qid: generateQueryId(),
          result: {
            account_id: device.config.auth.accountId,
            phone: null,
            profiles: [],
            sessions_count: 1,
            username: environment.ACCOUNT_USERNAME
          }
        })
      })
      .catch(error => {
        logger.error('failed to get account info: ', error)
        response.status(500).end()
      })
  })

  app.get('/account/settings/v1/reminders', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    response.status(200).json({
      qid: generateQueryId(),
      result: []
    })
  })

  app.get('/global_settings', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        response.status(200).json({
          qid: generateQueryId(),
          result: {
            vk_domain: device.config.global.vkDomain
          }
        })
      })
      .catch(error => {
        logger.error('failed to get config: ', error)
        response.status(500).end()
      })
  })

  app.get('/device/settings/v1/:device_id/:settings_id', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    if (request.deviceInfo.deviceId !== request.params['device_id']) {
      response.status(401).end()
      return
    }

    let result: unknown

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        switch (request.params['settings_id']) {
          case 'alarm_music': {
            result = []
            break
          }
          case 'alarms': {
            result = []
            break
          }
          case 'content_privacy': {
            result = [convertContentPrivacyConfig(request.deviceInfo.deviceId,
              device.config.settings.contentPrivacy)]
            break
          }
          case 'general': {
            result = [convertGeneralConfig(request.deviceInfo.deviceId, device.name,
              device.config.settings.general)]
            break
          }
          case 'night_light': {
            result = []
            break
          }
          case 'night_mode': {
            result = [convertNightModeConfig(request.deviceInfo.deviceId,
              device.config.settings.nightMode)]
            break
          }
          case 'safe_mode': {
            result = [convertSafeModeConfig(request.deviceInfo.deviceId, device.config.settings.safeMode)]
            break
          }
          case 'spotify': {
            result = [convertSpotifyConfig(request.deviceInfo.deviceId, device.config.settings.spotify)]
            break
          }
          case 'stereo': {
            result = [convertStereoConfig(request.deviceInfo.deviceId, device.config.settings.stereo)]
            break
          }
          case 'telegram': {
            result = [convertTelegramConfig(request.deviceInfo.deviceId, device.config.settings.telegram)]
            break
          }
          case 'vk_calls': {
            result = [convertVkCallsConfig(request.deviceInfo.deviceId, device.config.settings.vkCalls)]
            break
          }
          default: {
            result = []
            break
          }
        }

        response.status(200).json({
          qid: generateQueryId(),
          result
        })
      })
      .catch(error => {
        logger.error('failed to get config: ', error)
        response.status(500).end()
      })
  })

  const generalConfigType = z.object({
    coordinates: z.array(z.number()).optional(),
    master_volume: z.number().optional()
  })

  app.put('/device/settings/v1/:device_id/:settings_id/:device_id_2', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    if (request.deviceInfo.deviceId !== request.params['device_id']) {
      response.status(401).end()
      return
    }

    let result: unknown

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        const oldConfig = structuredClone(device.config)

        switch (request.params['settings_id']) {
          case 'alarm_music': {
            break
          }
          case 'alarms': {
            break
          }
          case 'content_privacy': {
            device.config.settings.contentPrivacy.revision++

            result = {
              new: convertContentPrivacyConfig(request.deviceInfo.deviceId, device.config.settings.contentPrivacy),
              old: convertContentPrivacyConfig(request.deviceInfo.deviceId, oldConfig.settings.contentPrivacy)
            }
            break
          }
          case 'general': {
            const update = generalConfigType.parse(request.body)
            if (update.master_volume) {
              device.config.settings.general.masterVolume = update.master_volume
            }
            if (update.coordinates) {
              device.config.settings.general.coordinates = update.coordinates
            }

            device.config.settings.general.revision++

            result = {
              new: convertGeneralConfig(request.deviceInfo.deviceId, device.name, device.config.settings.general),
              old: convertGeneralConfig(request.deviceInfo.deviceId, device.name, oldConfig.settings.general)
            }
            break
          }
          case 'night_light': {
            break
          }
          case 'night_mode': {
            device.config.settings.nightMode.revision++

            result = {
              new: convertNightModeConfig(request.deviceInfo.deviceId, device.config.settings.nightMode),
              old: convertNightModeConfig(request.deviceInfo.deviceId, oldConfig.settings.nightMode)
            }
            break
          }
          case 'safe_mode': {
            device.config.settings.safeMode.revision++

            result = {
              new: convertSafeModeConfig(request.deviceInfo.deviceId, device.config.settings.safeMode),
              old: convertSafeModeConfig(request.deviceInfo.deviceId, oldConfig.settings.safeMode)
            }
            break
          }
          case 'spotify': {
            device.config.settings.spotify.revision++

            result = {
              new: convertSpotifyConfig(request.deviceInfo.deviceId, device.config.settings.spotify),
              old: convertSpotifyConfig(request.deviceInfo.deviceId, oldConfig.settings.spotify)
            }
            break
          }
          case 'stereo': {
            device.config.settings.stereo.revision++

            result = {
              new: convertStereoConfig(request.deviceInfo.deviceId, device.config.settings.stereo),
              old: convertStereoConfig(request.deviceInfo.deviceId, oldConfig.settings.stereo)
            }
            break
          }
          case 'telegram': {
            device.config.settings.telegram.revision++

            result = {
              new: convertTelegramConfig(request.deviceInfo.deviceId, device.config.settings.telegram),
              old: convertTelegramConfig(request.deviceInfo.deviceId, oldConfig.settings.telegram)
            }
            break
          }
          case 'vk_calls': {
            device.config.settings.vkCalls.revision++

            result = {
              new: convertVkCallsConfig(request.deviceInfo.deviceId, device.config.settings.vkCalls),
              old: convertVkCallsConfig(request.deviceInfo.deviceId, oldConfig.settings.vkCalls)
            }
            break
          }
          default: {
            break
          }
        }

        storage.saveConfig(device)
          .then(() => logger.debug('config saved'))
          .catch(error => logger.error('failed to save config: ', error))

        response.status(200).json({
          qid: generateQueryId(),
          result
        })
      })
      .catch(error => {
        logger.error('failed to get config: ', error)
        response.status(500).end()
      })
  })

  app.post('/rt_logs/send', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    response.status(500).end()
  })

  app.get('/account/vk/info', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(device => {
        response.status(200).json({
          qid: generateQueryId(),
          result: {
            access_token: device.config.vkAccountInfo.accessToken,
            bdate: device.config.vkAccountInfo.bdate,
            created: device.config.vkAccountInfo.created,
            email: device.config.vkAccountInfo.email,
            expires_in: 0,
            first_name: device.config.vkAccountInfo.firstName,
            last_name: device.config.vkAccountInfo.lastName,
            mobile_phone: device.config.vkAccountInfo.mobilePhone,
            sex: device.config.vkAccountInfo.sex,
            user_id: device.config.vkAccountInfo.userId
          }
        })
      })
      .catch(error => {
        logger.error('failed to get config: ', error)
        response.status(500).end()
      })
  })

  app.post('/device/toggles', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    response.status(200).json({
      qid: generateQueryId(),
      result: {
        config: {},
        revision: null,
        splits: ''
      }
    })
  })

  // OTA: колонка проверяет обновления, всегда отвечаем «обновлений нет»
  app.get('/device/firmware', (_request, response) => {
    response.status(200).json({
      qid: generateQueryId(),
      result: {
        capabilities: '0',
        description: null,
        filename: FIRMWARE_VERSION,
        label: 'local',
        need_auth: false,
        need_update: false,
        platform: 'Capsula-mini-6',
        source: 'local',
        ts: Math.floor(Date.now() / 1000),
        url: '',
        version: FIRMWARE_VERSION
      }
    })
  })

  // gRPC-проба возможностей: пустой unary ответ
  app.post('/vk.voice.grpc.front.v1.service.ClientProbe/AuthReady', (_request, response) => {
    response.status(200).header({ 'content-type': 'application/grpc' }).end()
  })

  app.post('/phrase/create/event', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const event = getQueryOrThrow(request, 'event')
    logger.info(`received event: ${event}, ${JSON.stringify(request.body)}`)
    response.status(200).json({
      qid: generateQueryId(),
      result: {
        phrase_id: randomUUID(),
        phrase_result: {
          asr_text: null,
          commands: [],
          controls: [],
          intent: 'radioegor146',
          secure: false,
          skill: 'radioegor146'
        }
      }
    })
  })

  const parametersType = z.object({
    callback_data: z.string().optional(),
  })

  const listenCallbackData = z.object({
    dialogId: z.uuid()
  })

  const phraseIdToDialogIdMap: Map<string, string> = new Map()
  const dialogIdToDialogMap: Map<string, Dialog> = new Map()
  const deviceIdToActiveDialogIdMap: Map<string, string> = new Map()
  const eventIdToTextMap: Map<string, string> = new Map()

  enum PhraseResult {
    OKAY_GO_ON = 1,
    KEYWORD_CONFIRMED = 2,
    KEYWORD_NOT_CONFIRMED = 3,
    END_OF_PHRASE = 4,
    ERROR_OCCURRED = 5,
    PHRASE_RECOGNISED = 6,
  }

  app.post('/phrase/create/text', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const text = getQueryOrThrow(request, 'text')
    const eventText = eventIdToTextMap.get(text)
    if (!eventText) {
      response.status(500).end()
      return
    }

    const dialogId: string = randomUUID()

    const activeDialogId = deviceIdToActiveDialogIdMap.get(request.deviceInfo.deviceId)
    if (activeDialogId && dialogId !== activeDialogId) {
      dialogIdToDialogMap.get(activeDialogId)?.close()
      dialogIdToDialogMap.delete(activeDialogId)
      deviceIdToActiveDialogIdMap.delete(request.deviceInfo.deviceId)
    }

    const dialog = dialogIdToDialogMap.get(dialogId) ?? (() => {
      const newDialog = new Dialog(backends)
      newDialog.init()
      return newDialog
    })()
    dialogIdToDialogMap.set(dialogId, dialog)

    dialog.handleEventText(eventText).catch(error => {
      logger.error('failed to handleStartVoice: ', error)
      dialogIdToDialogMap.delete(dialogId)
    })

    const phraseId = randomUUID()
    phraseIdToDialogIdMap.set(phraseId, dialogId)

    response.status(200).json({
      qid: generateQueryId(),
      result: {
        phrase_id: phraseId,
        phrase_result: {
          asr_text: null,
          commands: [],
          controls: [],
          intent: 'radioegor146',
          page_token: `${phraseId}/${randomUUID()}`,
          secure: false,
          skill: 'radioegor146'
        }
      }
    })
  })

  app.post('/phrase/create/0chunk', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const boundary = getBoundary(String(request.headers['content-type']))
    const parts = parse(request.body, boundary)

    const rawParameters = parts.find(part => part.name === 'params')
    const rawChunk = parts.find(part => part.name === 'chunk')

    if (!rawParameters) {
      throw new Error('params or chunk not found')
    }

    let dialogId: string = randomUUID()

    const parameters = parametersType.parse(JSON.parse(rawParameters.data.toString('utf8')))
    if (parameters.callback_data) {
      dialogId = listenCallbackData.parse(JSON.parse(parameters.callback_data)).dialogId
    }

    const activeDialogId = deviceIdToActiveDialogIdMap.get(request.deviceInfo.deviceId)
    if (activeDialogId && dialogId !== activeDialogId) {
      dialogIdToDialogMap.get(activeDialogId)?.close()
      dialogIdToDialogMap.delete(activeDialogId)
      deviceIdToActiveDialogIdMap.delete(request.deviceInfo.deviceId)
    }

    const dialog = dialogIdToDialogMap.get(dialogId) ?? (() => {
      const newDialog = new Dialog(backends)
      newDialog.init()
      return newDialog
    })()
    dialogIdToDialogMap.set(dialogId, dialog)

    dialog.handleStartVoice().then(() => {
      if (rawChunk) {
        dialog.handleVoiceChunk(rawChunk.data, rawChunk.type, 0)
      }
    }).catch(error => {
      logger.error('failed to handleStartVoice: ', error)
      dialogIdToDialogMap.delete(dialogId)
    })

    const phraseId = randomUUID()
    phraseIdToDialogIdMap.set(phraseId, dialogId)

    response.status(200).json({
      qid: generateQueryId(),
      result: {
        chunk_length_hint: 80,
        phrase_id: phraseId,
        status: PhraseResult.OKAY_GO_ON
      }
    })
  })

  app.post('/phrase/add', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const chunkNumber = Number.parseInt(getQueryOrThrow(request, 'chunk_num'))

    const phraseId = getQueryOrThrow(request, 'phrase_id')
    const dialogId = phraseIdToDialogIdMap.get(phraseId)
    if (!dialogId) {
      response.status(500).end()
      return
    }

    const dialog = dialogIdToDialogMap.get(dialogId)
    if (!dialog) {
      response.status(500).end()
      return
    }

    const finished = dialog.handleVoiceChunk(request.body, request.headers['content-type'] ?? 'unknown', chunkNumber)

    response.status(200).json({
      qid: generateQueryId(),
      result: {
        chunk_length_hint: 80,
        status: finished ? PhraseResult.PHRASE_RECOGNISED : PhraseResult.KEYWORD_CONFIRMED
      }
    })
  })

  app.get('/phrase/result', async (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const phraseId = getQueryOrThrow(request, 'phrase_id')
    const dialogId = phraseIdToDialogIdMap.get(phraseId)
    if (!dialogId) {
      response.status(500).end()
      return
    }

    const dialog = dialogIdToDialogMap.get(dialogId)
    if (!dialog) {
      response.status(500).end()
      return
    }

    // Капсула Мини (44.90) получает весь ответ ассистента здесь,
    // /phrase/commands не использует. Ждём финальный результат диалога
    // (частичные ответы склеиваются в один список команд).
    const deadline = Date.now() + 25_000
    const parts: DialogResult[] = []
    while (Date.now() < deadline) {
      const part = dialog.getNextResult()
      if (part) {
        parts.push(part)
        if (part.finished) {
          break
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const asrText = dialog.getLastAsrResult()
    const last = parts.at(-1)
    const finished = last !== undefined && last.finished === true
    const shouldListen = finished && last !== undefined && last.shouldListen === true

    if (finished && !shouldListen) {
      dialog.close()
      dialogIdToDialogMap.delete(dialogId)
      deviceIdToActiveDialogIdMap.delete(request.deviceInfo.deviceId)
    }

    let commands: unknown[] = []
    try {
      const device = await storage.getOrCreate(request.deviceInfo.deviceId,
        getDefaultDeviceConfig())

      commands = (await Promise.all(parts.map(async (part, index) => {
        const isLast = index === parts.length - 1
        const built = await buildDeviceDirectives(part.directives, request.deviceInfo!, device)

        const chunkCommands: unknown[] = [...built]

        if (part.text !== null) {
          const streamId = randomUUID()
          streamIdToSpeechMap.set(streamId, part.speech)
          chunkCommands.push({
            blocking: true,
            encoder: 'opus',
            encoder_bitrate: null,
            encoder_frame_size: null,
            force_say: false,
            kws_skip: null,
            long_reader_request: false,
            model_name: 'tts',
            normalize: true,
            speed: 1,
            stream_hls: false,
            stream_id: streamId,
            text: part.text,
            type: 'tts'
          })
        }

        if (isLast && part.finished && part.shouldListen) {
          chunkCommands.push({
            blocking: true,
            callback_data: JSON.stringify({ dialogId }),
            min_waiting_time: 4,
            mute_activation_sound: false,
            type: 'listen'
          })
        }

        return chunkCommands
      }))).flat()
    } catch (error) {
      logger.error('failed to build phrase result: ', error)
    }

    response.status(200).json({
      qid: generateQueryId(),
      result: {
        asr_text: asrText,
        commands,
        controls: [],
        intent: 'radioegor146',
        secure: false,
        skill: 'radioegor146'
      }
    })
  })

  app.get('/stream', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    const streamId = getQueryOrThrow(request, 'stream_id')
    const buffer = streamIdToSpeechMap.get(streamId)
    streamIdToSpeechMap.delete(streamId)

    if (buffer) {
      response.status(200).header({
        'content-type': 'audio/ogg'
      }).end(buffer)
      return
    }

    response.status(500).end()
  })

  const streamIdToSpeechMap: Map<string, Buffer> = new Map()

  /**
   * Преобразует директивы processor'а в команды колонки (volume, bluetooth, custom).
   * Общая для /phrase/commands и /phrase/result.
   */
  async function buildDeviceDirectives (directiveList: Directive[], deviceInfo: RequestDeviceInfo,
    device: DeviceInfo): Promise<unknown[]> {
    const directives: unknown[] = []

    let needConfigUpdate = false

    for (const directive of directiveList) {
      switch (directive.type) {
        case 'bluetoothDisable': {
          directives.push({
            turn_on: false,
            type: 'bluetooth_pair'
          })
          break
        }
        case 'bluetoothEnable': {
          directives.push({
            turn_on: true,
            type: 'bluetooth_pair'
          })
          break
        }
        case 'customMarusya': {
          directives.push(directive.data)
          break
        }
        case 'customQuasar': {
          continue
        }
        case 'soundLouder': {
          needConfigUpdate = true
          device.config.settings.general.masterVolume =
            Math.min(100, device.config.settings.general.masterVolume + 10)
          device.config.settings.general.revision++
          storage.saveConfig(device)
            .then(() => logger.debug('config saved'))
            .catch(error => logger.error('failed to save config: ', error))
          directives.push({
            level: device.config.settings.general.masterVolume,
            type: 'volume_control'
          })
          break
        }
        case 'soundQuieter': {
          needConfigUpdate = true
          device.config.settings.general.masterVolume =
            Math.max(10, device.config.settings.general.masterVolume - 10)
          device.config.settings.general.revision++
          storage.saveConfig(device)
            .then(() => logger.debug('config saved'))
            .catch(error => logger.error('failed to save config: ', error))
          directives.push({
            level: device.config.settings.general.masterVolume,
            type: 'volume_control'
          })
          break
        }
        case 'soundSetLevel': {
          needConfigUpdate = true
          device.config.settings.general.masterVolume = directive.level * 10
          device.config.settings.general.revision++
          storage.saveConfig(device)
            .then(() => logger.debug('config saved'))
            .catch(error => logger.error('failed to save config: ', error))
          directives.push({
            level: device.config.settings.general.masterVolume,
            type: 'volume_control'
          })
          continue
        }
      }
    }

    if (needConfigUpdate) {
      directives.push({
        settings: convertGeneralConfig(deviceInfo.deviceId, device.name, device.config.settings.general),
        type: 'general_settings_v1'
      })
    }

    return directives
  }

  app.post('/phrase/commands', (request, response) => {
    if (!request.deviceInfo) {
      response.status(500).end()
      return
    }

    let phraseId: string
    try {
      phraseId = getQueryOrThrow(request, 'phrase_id')
    } catch {
      const pageToken = String(request.body.page_token)
      if (pageToken.includes('/')) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        phraseId = pageToken.split('/')[0]!
      } else {
        throw new Error('no phrase id in page token as well?')
      }
    }

    const dialogId = phraseIdToDialogIdMap.get(phraseId)
    if (!dialogId) {
      response.status(500).end()
      return
    }

    const dialog = dialogIdToDialogMap.get(dialogId)
    if (!dialog) {
      response.status(500).end()
      return
    }

    const result = dialog.getNextResult()
    if (!result) {
      setTimeout(() => {
        response.status(200).json({
          qid: generateQueryId(),
          result: {
            commands: [],
            page_token: `${phraseId}/${randomUUID()}`
          }
        })
      }, 500)
      return
    }

    const streamId = randomUUID()
    streamIdToSpeechMap.set(streamId, result.speech)

    if (result.finished && !result.shouldListen) {
      dialog.close()
      dialogIdToDialogMap.delete(dialogId)
      deviceIdToActiveDialogIdMap.delete(request.deviceInfo.deviceId)
    }

    storage.getOrCreate(request.deviceInfo.deviceId,
      getDefaultDeviceConfig())
      .then(async device => {
        const directives = await buildDeviceDirectives(result.directives, request.deviceInfo!, device)

        response.status(200).json({
          qid: generateQueryId(),
          result: {
            ...(result.finished
              ? {}
              : {
                  page_token: `${phraseId}/${randomUUID()}`
                }),
            commands: [
              ...directives,
              ...(result.text === null
                ? []
                : [{
                    blocking: true,
                    encoder: 'opus',
                    encoder_bitrate: null,
                    encoder_frame_size: null,
                    force_say: false,
                    kws_skip: null,
                    long_reader_request: false,
                    model_name: 'tts',
                    normalize: true,
                    speed: 1,
                    stream_hls: false,
                    stream_id: streamId,
                    text: result.text,
                    type: 'tts'
                  }]),
              ...(result.finished && result.shouldListen
                ? [
                    {
                      blocking: true,
                      callback_data: JSON.stringify({
                        dialogId
                      }),
                      min_waiting_time: 4,
                      mute_activation_sound: false,
                      type: 'listen'
                    }
                  ]
                : [])],
          }
        })
      })
      .catch(error => {
        logger.error('failed to fetch config: ', error)
        response.status(500).end()
      })
  })

  const wsServer = new WebSocketServer({
    noServer: true
  })

  server.on('upgrade', (request, socket, head) => {
    if (request.url?.startsWith('/connect')) {
      const handleConnection = () => {
        wsServer.handleUpgrade(request, socket, head, client => {
          wsServer.emit('connection', client, request)
        })
      }

      if (environment.AUTH_MODE !== 'enforce') {
        handleConnection()
        return
      }

      const deviceId = new URLSearchParams(request.url.split('?')[1] ?? '').get('device_id')
      if (!deviceId) {
        socket.destroy()
        return
      }

      storage.getOrCreate(deviceId, getDefaultDeviceConfig())
        .then(device => {
          const expectedSecret = device.config.auth.sessionSecret
          if (expectedSecret && request.headers.authorization === `Bearer ${expectedSecret}`) {
            handleConnection()
            return
          }

          socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        })
        .catch(() => {
          socket.destroy()
        })
      return
    }
    socket.destroy()
  })

  const router: VCRouter = {
    connections: new Set()
  }

  wsServer.addListener('connection', (connection, request) => {
    const parameters = new URLSearchParams(request.url?.split('?')[1] ?? '')
    const deviceId = parameters.get('device_id')
    if (!deviceId) {
      logger.warn('got connection without device id')
      connection.close()
      return
    }

    const vcConnection = new VCConnection(connection, deviceId, backends,
      streamIdToSpeechMap, eventIdToTextMap)
    router.connections.add(vcConnection)
    logger.info(`received WS connection from ${deviceId}`)

    connection.addEventListener('close', reason => {
      logger.info('WS closed: ', reason.code)
      router.connections.delete(vcConnection)
    })
    connection.addEventListener('error', error => {
      logger.warn('WS error: ', error)
      router.connections.delete(vcConnection)
    })
  })

  return router
}

function generateQueryId (): string {
  return randomBytes(16).toString('hex')
}

function getQueryOrThrow (request: Request, id: string): string {
  const field = request.query[id]
  if (!field) {
    throw new Error(`no '${id}' in query`)
  }
  return String(field)
}
