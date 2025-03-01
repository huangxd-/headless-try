import { NextResponse } from "next/server";
import fs from "node:fs/promises"; // 使用 promises 版本的 fs
import path from "node:path";
import cfCheck from "@/utils/cfCheck";
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

export const maxDuration = 60; // 最大执行时间 60 秒
export const dynamic = "force-dynamic";

const chromium = require("@sparticuz/chromium-min");
const puppeteer = require("puppeteer-core");

export async function GET(request) {
  const url = new URL(request.url);
  const urlStr = url.searchParams.get("url");
  if (!urlStr) {
    return NextResponse.json(
      { error: "Missing url parameter" },
      { status: 400 }
    );
  }

  let browser = null;
  try {
    // 启动 Puppeteer
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "-disable-site-isolation-trials",
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

    // 拦截网络请求并下载静态资源
    await page.setRequestInterception(true);
    const resources = {}; // 存储原始 URL 和新 URL 的映射
    const assetDir = "/tmp/assets"; // Vercel 的临时目录
    await fs.mkdir(assetDir, { recursive: true });

    page.on("request", async (request) => {
      const requestUrl = request.url();
      const resourceType = request.resourceType();
      if (["image", "stylesheet", "script"].includes(resourceType)) {
        try {
          const response = await request.continue();
          const buffer = await response.buffer();
          const fileName = path.basename(requestUrl).replace(/[^a-zA-Z0-9.]/g, "_");
          const filePath = path.join(assetDir, fileName);
          await fs.writeFile(filePath, buffer);
          resources[requestUrl] = `/assets/${fileName}`; // 本地资源路径
        } catch (err) {
          console.error(`Failed to fetch resource ${requestUrl}:`, err);
          request.continue(); // 如果失败，继续请求
        }
      } else {
        request.continue();
      }
    });

    // 访问目标页面
    const preloadFile = fs.readFileSync(
      path.join(process.cwd(), "/src/utils/preload.js"),
      "utf8"
    );
    await page.evaluateOnNewDocument(preloadFile);
    await page.goto(urlStr, {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await cfCheck(page);

    // 获取完整 HTML
    let html = await page.content();

    // 重写资源 URL
    for (const [originalUrl, newUrl] of Object.entries(resources)) {
      html = html.replace(new RegExp(originalUrl, "g"), newUrl);
    }

    // 返回 HTML 和静态资源的元数据
    const headers = new Headers();
    headers.set("Content-Type", "text/html");

    return new NextResponse(html, { status: 200, headers });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  } finally {
    if (browser) await browser.close();
  }
}

// 静态资源路由（可选，用于访问 /assets/ 下的文件）
export async function GET(request, { params }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/assets/")) {
    const fileName = url.pathname.replace("/assets/", "");
    const filePath = path.join("/tmp/assets", fileName);
    try {
      const fileBuffer = await fs.readFile(filePath);
      const headers = new Headers();
      headers.set("Content-Type", getContentType(fileName));
      return new NextResponse(fileBuffer, { status: 200, headers });
    } catch (err) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
  }
}

// 根据文件扩展名返回 Content-Type
function getContentType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
    case ".jpg":
    case ".jpeg":
      return "image/" + (ext === ".png" ? "png" : "jpeg");
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    default:
      return "application/octet-stream";
  }
}
