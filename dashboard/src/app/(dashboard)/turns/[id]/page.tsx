import { notFound } from 'next/navigation';
import { getTurn, listInspectionItems, listAuditLog } from '@/lib/data/turns';
import { TurnDetail } from '@/components/turns/turn-detail';

export const dynamic = 'force-dynamic';

export default async function TurnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const turn = await getTurn(id);
  if (!turn) notFound();

  const [items, audit] = await Promise.all([listInspectionItems(id), listAuditLog(id)]);

  return <TurnDetail turn={turn} items={items} audit={audit} />;
}
