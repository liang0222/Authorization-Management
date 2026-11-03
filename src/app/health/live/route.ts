import { NextResponse } from "next/server";

/**
 * GET /health/live —— 存活探针（规格 18.2）。
 *
 * 只回答“进程还在不在”，不碰数据库、不碰签名密钥、不读环境配置。
 * 一旦这里也要查库，数据库抖动会把整个实例判死，编排器就会无谓重启。
 */
export function GET() {
  return NextResponse.json(
    { status: "ok", uptime_seconds: Math.round(process.uptime()) },
    { headers: { "cache-control": "no-store" } },
  );
}
