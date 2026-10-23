import { useNavigate } from 'react-router-dom';
import { Text, Card, Spinner } from '../themed';
import TodoList from './TodoList';
import SharedTodos from './SharedTodos';
import StickyNote from './StickyNote';
import SectionHeader from './SectionHeader';
import AddItemButton from './AddItemButton';
import { createEntry } from '../../services/entries';
import { useEntryNavigation } from '../../contexts/EntryNavigationContext';
import type { DayData, Todo, StickyNote as StickyNoteType } from '../../types/todo';

interface DayDetailProps {
  dayData: DayData | null;
  isLoading: boolean;
  stickyNote: StickyNoteType | null;
  onCreateTodo: (content: string, scheduledTime?: string) => Promise<Todo | null>;
  onUpdateTodo: (id: string, updates: { content?: string; scheduledTime?: string | null; completed?: boolean }) => Promise<Todo | null>;
  onDeleteTodo: (id: string) => Promise<boolean>;
  onReorderTodos: (todoIds: string[], reorderedTodos: Todo[]) => Promise<void>;
  onUpdateStickyNote: (id: string, content: string) => Promise<StickyNoteType | null>;
}

export default function DayDetail({
  dayData,
  isLoading,
  stickyNote,
  onCreateTodo,
  onUpdateTodo,
  onDeleteTodo,
  onReorderTodos,
  onUpdateStickyNote,
}: DayDetailProps) {
  const navigate = useNavigate();
  const { navigateToEntry } = useEntryNavigation();

  if (isLoading && !dayData) {
    return (
      <div className="day-detail-loading">
        <Spinner size="md" />
      </div>
    );
  }

  if (!dayData) {
    return (
      <div className="day-detail-empty">
        <Text variant="muted">Select a day to view details</Text>
      </div>
    );
  }

  const handleAddEntry = async () => {
    const newEntry = await createEntry(dayData.date);
    navigateToEntry(newEntry.id);
    navigate('/entries');
  };

  const handleViewEntry = () => {
    if (dayData.entryId) {
      navigateToEntry(dayData.entryId);
      navigate('/entries');
    }
  };

  return (
    <div className="day-detail">
      <div className="day-detail-section">
        <SectionHeader title="Journal Entry" indicatorType="entry" />
        {dayData.hasEntry ? (
          <Card
            padding="md"
            className="day-detail-entry-card"
            onClick={handleViewEntry}
          >
            <Text variant="secondary" className="day-detail-entry-preview">
              {dayData.entryPreview}
            </Text>
          </Card>
        ) : (
          <AddItemButton label="Add entry" onClick={handleAddEntry} />
        )}
      </div>

      <TodoList
        todos={dayData.todos}
        onCreateTodo={onCreateTodo}
        onUpdateTodo={onUpdateTodo}
        onDeleteTodo={onDeleteTodo}
        onReorderTodos={onReorderTodos}
      />

      <SharedTodos date={dayData.date} />
      <div className="day-detail-section">
        <SectionHeader title="Sticky Note" indicatorType="sticky-note" />
        {stickyNote && (
          <StickyNote
            id={stickyNote.id}
            content={stickyNote.content}
            onUpdate={onUpdateStickyNote}
          />
        )}
      </div>
    </div>
  );
}
