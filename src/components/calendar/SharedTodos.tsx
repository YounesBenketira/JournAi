import { useSync } from '../../hooks/useSync';
import { Text, Card } from '../themed';
import SectionHeader from './SectionHeader';

export default function SharedTodos({ date }: { date: string }) {
  const { sharedTodos } = useSync();
  const records = sharedTodos.filter(todo => todo.payload.date === date);
  if (!records.length) return null;
  return <section className="day-detail-section" aria-label="Todos shared with you">
    <SectionHeader title="Shared with you" indicatorType="todo" />
    {records.map(todo => <Card key={`${todo.shareId}/${todo.recordId}`} padding="md" className="shared-todo">
      <Text variant="secondary">{todo.ownerEmail} · View only</Text>
      <Text variant="primary">{todo.payload.completed ? '✓ ' : '○ '}{todo.payload.content}</Text>
    </Card>)}
  </section>;
}
