import { NextResponse } from "next/server";
import fsPromises from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import iconv from "iconv-lite";
import cfCheck from "@/utils/cfCheck";
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const chromium = require("@sparticuz/chromium-min");
const puppeteer = require("puppeteer-core");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(request) {
  const url = new URL(request.url);
  const urlStr = url.searchParams.get("url");
  const pathname = url.pathname;

  // 处理静态资源请求
  if (pathname.startsWith("/try/assets/")) {
    const fileName = pathname.replace("/try/assets/", "");
    const filePath = path.join("/tmp/assets", fileName);
    try {
      const fileBuffer = await fsPromises.readFile(filePath);
      const headers = new Headers();
      headers.set("Content-Type", getContentType(fileName));
      return new NextResponse(fileBuffer, { status: 200, headers });
    } catch (err) {
      console.error(`Failed to load asset ${fileName}:`, err);
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }

  // 处理页面抓取请求
  if (!urlStr) {
    return NextResponse.json(
      { error: "Missing url parameter" },
      { status: 400 }
    );
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "--disable-site-isolation-trials",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: isDev ? false : "new",
      debuggingPort: isDev ? 9222 : undefined,
    });

    const pages = await browser.pages();
    const page = pages[0];
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    // 设置请求拦截
    await page.setRequestInterception(true);
    const resources = {};
    const assetDir = "/tmp/assets";
    await fsPromises.mkdir(assetDir, { recursive: true });

    // 拦截请求
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (["image", "stylesheet", "script"].includes(resourceType)) {
        request.continue();
      } else {
        request.continue();
      }
    });

    // 监听响应，下载静态资源
    page.on("response", async (response) => {
      const requestUrl = response.url();
      const resourceType = response.request().resourceType();
      if (["image", "stylesheet", "script"].includes(resourceType)) {
        try {
          if (response.status() === 200) {
            const buffer = await response.buffer();
            if (buffer && buffer.length > 0) {
              const ext = path.extname(requestUrl) || `.${resourceType === "stylesheet" ? "css" : resourceType}`;
              const fileName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
              const filePath = path.join(assetDir, fileName);

              // 处理文本资源（CSS, JS）的编码
              let content = buffer;
              if (resourceType === "stylesheet" || resourceType === "script") {
                // 假设资源是 UTF-8，必要时可检测实际编码
                content = iconv.decode(buffer, "utf-8");
                content = iconv.encode(content, "utf-8");
              }

              await fsPromises.writeFile(filePath, content);
              resources[requestUrl] = `/try/assets/${fileName}`;
              console.log(`Saved resource: ${requestUrl} -> ${fileName}`);
            } else {
              console.warn(`Empty buffer for resource ${requestUrl}`);
            }
          } else {
            console.warn(`Non-200 status (${response.status()}) for resource ${requestUrl}`);
          }
        } catch (err) {
          console.error(`Failed to fetch resource ${requestUrl}:`, err.message);
        }
      }
    });

    // 加载 preload.js 并访问目标页面
    const preloadFile = fs.readFileSync(
      path.join(process.cwd(), "/src/utils/preload.js"),
      "utf8"
    );
    await page.evaluateOnNewDocument(preloadFile);

    // 访问页面并检查响应头
    const response = await page.goto(urlStr, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    const headers = response.headers();
    const contentTypeHeader = headers['content-type'] || 'text/html; charset=utf-8';
    console.log('Page Content-Type:', contentTypeHeader);

    await cfCheck(page);

    // 等待动态资源加载
    await wait(5000); // 增加到 5 秒，确保 JS 执行和动态 CSS 加载

    // 获取并重写 HTML
    let html = await page.content();

    // 检测页面编码
    const contentType = await page.evaluate(() => {
      const meta = document.querySelector('meta[charset]');
      return meta ? meta.getAttribute('charset') : 'UTF-8';
    });
    console.log('Detected page charset:', contentType);

    // 如果不是 UTF-8，转换编码
    if (contentType.toLowerCase() !== 'utf-8') {
      html = iconv.decode(Buffer.from(html), contentType);
      html = iconv.encode(html, 'utf-8').toString();
    }

    // 确保 HTML 包含正确的 meta charset
    html = html.replace(
      /<head>/i,
      '<head><meta charset="UTF-8">'
    );

    // 重写资源 URL
    for (const [originalUrl, newUrl] of Object.entries(resources)) {
      html = html.replace(new RegExp(originalUrl, "g"), newUrl);
    }

    const headersResponse = new Headers();
    headersResponse.set("Content-Type", "text/html; charset=utf-8");
    return new NextResponse(html, { status: 200, headers: headersResponse });
  } catch (err) {
    console.error("Main process error:", err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  } finally {
    if (browser) await browser.close();
  }
}

function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
    case ".jpg":
    case ".jpeg":
      return "image/" + (ext === ".png" ? "png" : "jpeg");
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}