const { app, BrowserWindow, globalShortcut, clipboard, Tray, Menu, Notification, ipcMain } = require('electron')
const path = require('node:path')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const { GoogleGenerativeAI } = require("@google/generative-ai")
const Store = require('electron-store')
const { nativeImage } = require('electron')

const store = new Store()
const mainWindow = null
let tray = null
let settingsWindow = null
let genAI = null

function initializeGeminiAPI() {
  const apiKey = store.get('geminiApiKey')
  if (apiKey) {
    genAI = new GoogleGenerativeAI(apiKey)
    return true
  }
  return false
}

const createSettingsWindow = () => {
  if (settingsWindow) {
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  })

  settingsWindow.loadFile('settings.html')
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

const createTray = () => {
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
    tray.setToolTip('Processing screenshot...')

    const tempDir = path.join(app.getPath('temp'), 'screenshot-ocr')
    if (!fs.existsSync(tempDir)){
      fs.mkdirSync(tempDir, { recursive: true })
    }

    const screenshotPath = path.join(tempDir, 'temp_screenshot.png')
    execSync(`screencapture -i "${screenshotPath}"`)

    if (!fs.existsSync(screenshotPath)) {
      return  // User cancelled screenshot
    }

    tray.setToolTip('Converting image...')
    const imageBuffer = fs.readFileSync(screenshotPath)
    const base64Image = imageBuffer.toString('base64')

    tray.setToolTip('Processing with Gemini...')
    const text = await processImage(base64Image)
    if (!text) throw new Error('No text was detected')

    clipboard.writeText(text)
    fs.unlinkSync(screenshotPath)

    new Notification({
      title: 'Screenshot OCR',
      body: 'Text copied to clipboard!'
    }).show()

  } catch (error) {
    new Notification({
      title: 'Screenshot OCR',
      body: `Error: ${error.message}`
    }).show()
  } finally {
    tray.setToolTip('Screenshot OCR')
  }
}

async function processImage(base64Image) {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" })

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/png"
        }
      },
      `You are an advanced image analysis AI capable of extracting text from images. Your task is to carefully examine the provided image and extract any text content it contains.

                            Please follow these steps:

                            1. Extract the text:
                               - Carefully read and transcribe all text visible in the image.
                               - Sanitize the extracted text.

                            2. Output the extracted text:
                               - Provide only the extracted text, without any additional commentary or formatting.

                            Remember, your final output should contain only the extracted text, nothing else.`
    ])

    return result.response.text()
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