const { app, BrowserWindow, globalShortcut, clipboard, Tray, Menu, Notification, ipcMain } = require('electron')
const path = require('node:path')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const { GoogleGenerativeAI } = require("@google/generative-ai")
const Store = require('electron-store')
const { nativeImage } = require('electron')

const store = new Store({
  defaults: {
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

let tray = null
let settingsWindow = null
let chatWindow = null
let genAI = null
let currentScreenshot = null
let currentChat = null

function initializeGeminiAPI() {
  const apiKey = store.get('geminiApiKey')
  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey)
    return true
  }
  return false
}

function createSettingsWindow() {
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

  settingsWindow.loadFile('settings.html')

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

function createChatWindow() {
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

  chatWindow.loadFile('chat.html')

  chatWindow.once('ready-to-show', () => {
    chatWindow.show()
    if (currentScreenshot) {
      chatWindow.webContents.send('screenshot-taken', currentScreenshot)
    }
  })

  chatWindow.on('closed', () => {
    chatWindow = null
    currentScreenshot = null
    currentChat = null
  })
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'))

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

async function takeScreenshot() {
  if (!initializeGeminiAPI()) {
    new Notification({
      title: 'Screenshot OCR',
      body: 'Please set your Gemini API key in Settings first'
    }).show()
    createSettingsWindow()
    return
  }

  try {
    tray.setToolTip('Taking screenshot...')

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
      body: `Error: ${error.message}`
    }).show()
  } finally {
    tray.setToolTip('Screenshot OCR')
  }
}

async function processImageWithPrompt(base64Image, prompt, shouldStream = false, event = null) {
  try {
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
        if (event) {
          event.sender.send('stream-chunk', chunkText)
        }
      }
      return null
    } else {
      const result = await currentChat.sendMessage(message)
      return result.response.text()
    }
  } catch (error) {
    throw new Error(error.message || 'Failed to process image')
  }
}

ipcMain.on('save-api-key', (event, apiKey) => {
  store.set('geminiApiKey', apiKey)
  initializeGeminiAPI()
  new Notification({
    title: 'Screenshot OCR',
    body: 'API key saved successfully!'
  }).show()
  if (settingsWindow) {
    settingsWindow.close()
  }
})

ipcMain.handle('get-api-key', () => {
  return store.get('geminiApiKey')
})

ipcMain.handle('get-custom-prompts', () => {
  return store.get('customPrompts')
})

ipcMain.handle('process-image', async (event, { prompt, stream }) => {
  if (!currentScreenshot) throw new Error('No screenshot available')
  return processImageWithPrompt(currentScreenshot, prompt, stream, event)
})

ipcMain.on('save-custom-prompts', (event, prompts) => {
  store.set('customPrompts', prompts)
})

ipcMain.on('copy-to-clipboard', (event, text) => {
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

app.on('window-all-closed', (e) => {
  e.preventDefault()
})