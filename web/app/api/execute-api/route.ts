import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { url, method = 'GET', headers = {}, params = {}, body } = await req.json();

    let targetUrl = url.trim();
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    const urlObj = new URL(targetUrl);
    Object.entries(params).forEach(([k, v]) => { if (k) urlObj.searchParams.set(k, String(v)); });

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    if (body && ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())) {
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(urlObj.toString(), fetchOptions);
    const responseBody = await res.text();

    return NextResponse.json({ success: res.ok, status_code: res.status, body: responseBody });
  } catch (e: unknown) {
    return NextResponse.json({ success: false, status_code: -1, body: e instanceof Error ? e.message : 'Error' }, { status: 500 });
  }
}
