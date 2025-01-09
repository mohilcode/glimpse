import {
  app,
  BrowserWindow,
  globalShortcut,
  clipboard,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
  IpcMainInvokeEvent,
  Event
} from 'electron'
import path from 'path'
import { execSync } from 'child_process'
import fs from 'fs'
import { GoogleGenerativeAI, ChatSession } from '@google/generative-ai'
import Store from 'electron-store'

interface CustomPrompt {
  name: string
  prompt: string
  copyToClipboard: boolean
  closeAfterResponse: boolean
}

interface StoreSchema {
  geminiApiKey: string
  customPrompts: CustomPrompt[]
}

interface ProcessImageRequest {
  prompt: string
  stream: boolean
}

const loadFile = (filename: string): string => {
  if (filename.endsWith('.html')) {
    return path.join(__dirname, 'templates', filename)
  }
  return path.join(__dirname, '..', 'public', filename)
}

const store = new Store<StoreSchema>({
  defaults: {
    geminiApiKey: '',
    customPrompts: [
      {
        name: 'Extract Text',
        prompt: 'Extract and return only the text from this image, without any additional commentary.',
        copyToClipboard: true,
        closeAfterResponse: false
      },
      {
        name: 'Analyze Image',
        prompt: 'Analyze this image and describe what you see in detail.',
        copyToClipboard: false,
        closeAfterResponse: false
      }
    ]
  }
})

let tray: Tray | null = null
let settingsWindow: BrowserWindow | null = null
let chatWindow: BrowserWindow | null = null
let genAI: GoogleGenerativeAI | null = null
let currentScreenshot: string | null = null
let currentChat: ChatSession | null = null

function initializeGeminiAPI(): boolean {
  const apiKey = store.get('geminiApiKey')
  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey)
    return true
  }
  return false
}

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 15 }
  })

  settingsWindow.loadFile(loadFile('settings.html'))

  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function createChatWindow(): void {
  if (chatWindow) {
    chatWindow.webContents.send('reset-chat')
    chatWindow.focus()
    return
  }

  chatWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 15 }
  })

  chatWindow.loadFile(loadFile('chat.html'))

  chatWindow.once('ready-to-show', () => {
    chatWindow?.show()
    if (currentScreenshot) {
      chatWindow?.webContents.send('screenshot-taken', currentScreenshot)
    }
  })

  chatWindow.on('closed', () => {
    chatWindow = null
    currentScreenshot = null
    currentChat = null
  })
}

function createTray(): void {
  const icon = nativeImage.createFromPath(loadFile('icon.png'))

  if (process.platform === 'darwin') {
    const resizedIcon = icon.resize({
      width: 16,
      height: 16
    })
    resizedIcon.setTemplateImage(true)
    tray = new Tray(resizedIcon)
  } else {
    const resizedIcon = icon.resize({
      width: 16,
      height: 16
    })
    tray = new Tray(resizedIcon)
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Take Screenshot (⌘+Shift+S)',
      click: () => takeScreenshot()
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => createSettingsWindow()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ])

  tray.setToolTip('Screenshot OCR')
  tray.setContextMenu(contextMenu)
}

async function takeScreenshot(): Promise<void> {
  if (!initializeGeminiAPI()) {
    new Notification({
      title: 'Screenshot OCR',
      body: 'Please set your Gemini API key in Settings first'
    }).show()
    createSettingsWindow()
    return
  }

  try {
    tray?.setToolTip('Taking screenshot...')

    const tempDir = path.join(app.getPath('temp'), 'screenshot-ocr')
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const screenshotPath = path.join(tempDir, 'temp_screenshot.png')
    execSync(`screencapture -i "${screenshotPath}"`)

    if (!fs.existsSync(screenshotPath)) {
      return
    }

    const imageBuffer = fs.readFileSync(screenshotPath)
    currentChat = null
    currentScreenshot = imageBuffer.toString('base64')

    if (chatWindow) {
      chatWindow.webContents.send('reset-chat')
      chatWindow.webContents.send('screenshot-taken', currentScreenshot)
      chatWindow.focus()
    } else {
      createChatWindow()
    }

    fs.unlinkSync(screenshotPath)

  } catch (error) {
    new Notification({
      title: 'Screenshot OCR',
      body: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
    }).show()
  } finally {
    tray?.setToolTip('Screenshot OCR')
  }
}

async function processImageWithPrompt(
  base64Image: string,
  prompt: string,
  shouldStream = false,
  event: IpcMainInvokeEvent | null = null
): Promise<string | null> {
  try {
    if (!genAI) throw new Error('Gemini API not initialized')

    if (!currentChat) {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" })
      currentChat = model.startChat({
        history: [],
        generationConfig: {
          temperature: 1.0,
          maxOutputTokens: 2048,
        },
      })
    }

    const message = [{
      inlineData: {
        data: base64Image,
        mimeType: "image/png"
      }
    }, prompt]

    if (shouldStream) {
      const result = await currentChat.sendMessageStream(message)
      for await (const chunk of result.stream) {
        const chunkText = chunk.text()
        event?.sender.send('stream-chunk', chunkText)
      }
      return null
    } else {
      const result = await currentChat.sendMessage(message)
      return result.response.text()
    }
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Failed to process image')
  }
}

ipcMain.on('save-api-key', (_event, apiKey: string) => {
  store.set('geminiApiKey', apiKey)
  initializeGeminiAPI()
  new Notification({
    title: 'Screenshot OCR',
    body: 'API key saved successfully!'
  }).show()
  settingsWindow?.close()
})

ipcMain.handle('get-api-key', () => {
  return store.get('geminiApiKey')
})

ipcMain.handle('get-custom-prompts', () => {
  return store.get('customPrompts')
})

ipcMain.handle('process-image', async (event: IpcMainInvokeEvent, { prompt, stream }: ProcessImageRequest) => {
  if (!currentScreenshot) throw new Error('No screenshot available')
  return processImageWithPrompt(currentScreenshot, prompt, stream, event)
})

ipcMain.on('save-custom-prompts', (_event, prompts: CustomPrompt[]) => {
  store.set('customPrompts', prompts)
})

ipcMain.on('copy-to-clipboard', (_event, text: string) => {
  clipboard.writeText(text)
  new Notification({
    title: 'Screenshot OCR',
    body: 'Text copied to clipboard!'
  }).show()
})

ipcMain.on('reset-chat', () => {
  currentChat = null
})

app.whenReady().then(() => {
  createTray()

  if (!initializeGeminiAPI()) {
    createSettingsWindow()
  }

  globalShortcut.register('CommandOrControl+Shift+S', () => {
    takeScreenshot()
  })
})

app.on('window-all-closed', (e: Event) => {
  e.preventDefault()
})