import { NextResponse } from 'next/server';
import { checkUpstream, applyUpstream } from '@/lib/upstream';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await checkUpstream();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ status: 'error', error: String(error) }, { status: 500 });
  }
}

export async function POST() {
  try {
    const result = await applyUpstream();
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (error) {
    return NextResponse.json({ success: false, message: String(error) }, { status: 500 });
  }
}
