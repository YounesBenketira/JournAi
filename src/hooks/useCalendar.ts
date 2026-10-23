import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSync } from './useSync';
import type { DayData, StickyNote } from '../types/todo';
import type { MonthIndicators } from '../services/calendar';
import { getDayData, getIndicatorsByDateRange, getMonthIndicatorsRange } from '../services/calendar';
import { getTodayString, parseLocalDate, toDateString } from '../utils/date';
import * as todosService from '../services/todos';
import * as stickyNotesService from '../services/stickyNotes';
import { useCalendarContext } from '../contexts/CalendarContext';

export function useCalendar() {
  const { sharedTodos } = useSync();
  const {
    currentMonth,
    currentYear,
    selectedDate,
    setCurrentMonth,
    setCurrentYear,
    setSelectedDate,
  } = useCalendarContext();
  const [indicators, setIndicators] = useState<MonthIndicators | null>(null);
  const [dayData, setDayData] = useState<DayData | null>(null);
  const [stickyNote, setStickyNote] = useState<StickyNote | null>(null);
  const [isLoadingIndicators, setIsLoadingIndicators] = useState(true);
  const [isLoadingDayData, setIsLoadingDayData] = useState(false);
  const dayDataCacheRef = useRef<Map<string, DayData>>(new Map());
  const indicatorsRangeRef = useRef<{ startDate: string; endDate: string } | null>(null);
  const pendingIndicatorsRangeRef = useRef<{
    startDate: string;
    endDate: string;
    requestId: number;
    promise: Promise<void>;
  } | null>(null);
  const indicatorsRequestIdRef = useRef(0);

  const setDayDataWithStickyNote = useCallback((data: DayData | null) => {
    setDayData(data);
    if (!data) {
      setStickyNote(null);
      return;
    }

    dayDataCacheRef.current.set(data.date, data);

    if (data.stickyNotes.length > 0) {
      setStickyNote(data.stickyNotes[0]);
    } else {
      setStickyNote({ id: '', date: data.date, content: '' });
    }
  }, []);

  const loadIndicatorsByRange = useCallback(async (startDate: string, endDate: string) => {
    const normalizedStart = startDate <= endDate ? startDate : endDate;
    const normalizedEnd = startDate <= endDate ? endDate : startDate;
    const pendingRange = pendingIndicatorsRangeRef.current;

    if (
      pendingRange &&
      pendingRange.startDate === normalizedStart &&
      pendingRange.endDate === normalizedEnd
    ) {
      await pendingRange.promise;
      return;
    }

    const requestId = ++indicatorsRequestIdRef.current;

    setIsLoadingIndicators(true);

    const requestPromise = (async () => {
      try {
        const data = await getIndicatorsByDateRange(normalizedStart, normalizedEnd);
        if (requestId !== indicatorsRequestIdRef.current) {
          return;
        }
        indicatorsRangeRef.current = { startDate: normalizedStart, endDate: normalizedEnd };
        setIndicators(data);
      } catch (error) {
        console.error('Failed to load calendar indicators:', error);
      } finally {
        if (pendingIndicatorsRangeRef.current?.requestId === requestId) {
          pendingIndicatorsRangeRef.current = null;
        }
        if (requestId === indicatorsRequestIdRef.current) {
          setIsLoadingIndicators(false);
        }
      }
    })();

    pendingIndicatorsRangeRef.current = {
      startDate: normalizedStart,
      endDate: normalizedEnd,
      requestId,
      promise: requestPromise,
    };

    await requestPromise;
  }, []);

  const loadIndicators = useCallback(async () => {
    const currentMonthRange = getMonthIndicatorsRange(currentYear, currentMonth);
    const existingRange = indicatorsRangeRef.current;

    if (
      existingRange &&
      existingRange.startDate <= currentMonthRange.startDate &&
      existingRange.endDate >= currentMonthRange.endDate
    ) {
      await loadIndicatorsByRange(existingRange.startDate, existingRange.endDate);
      return;
    }

    await loadIndicatorsByRange(currentMonthRange.startDate, currentMonthRange.endDate);
  }, [currentYear, currentMonth, loadIndicatorsByRange]);

  const loadIndicatorsForDateRange = useCallback(async (startDate: string, endDate: string) => {
    const normalizedStart = startDate <= endDate ? startDate : endDate;
    const normalizedEnd = startDate <= endDate ? endDate : startDate;
    const existingRange = indicatorsRangeRef.current;

    if (
      existingRange &&
      existingRange.startDate === normalizedStart &&
      existingRange.endDate === normalizedEnd
    ) {
      return;
    }

    await loadIndicatorsByRange(normalizedStart, normalizedEnd);
  }, [loadIndicatorsByRange]);

  const loadDayData = useCallback(async (date: string) => {
    setIsLoadingDayData(true);
    const cached = dayDataCacheRef.current.get(date);
    if (cached) {
      setDayDataWithStickyNote(cached);
    }

    try {
      const data = await getDayData(date);
      setDayDataWithStickyNote(data);
    } catch (error) {
      console.error('Failed to load calendar day data:', error);
      if (!cached) {
        setDayDataWithStickyNote(null);
      }
    } finally {
      setIsLoadingDayData(false);
    }
  }, [setDayDataWithStickyNote]);

  useEffect(() => {
    const refresh = () => {
      dayDataCacheRef.current.clear();
      void loadIndicators();
      if (selectedDate) void loadDayData(selectedDate);
    };
    window.addEventListener('account:synced', refresh);
    return () => window.removeEventListener('account:synced', refresh);
  }, [selectedDate, loadDayData, loadIndicators]);

  const prefetchDayData = useCallback(async (date: string) => {
    if (dayDataCacheRef.current.has(date)) {
      return;
    }

    try {
      const data = await getDayData(date);
      dayDataCacheRef.current.set(date, data);
    } catch (error) {
      console.error('Failed to prefetch calendar day data:', error);
    }
  }, []);

  useEffect(() => {
    const currentMonthRange = getMonthIndicatorsRange(currentYear, currentMonth);
    const existingRange = indicatorsRangeRef.current;
    if (
      existingRange &&
      existingRange.startDate <= currentMonthRange.startDate &&
      existingRange.endDate >= currentMonthRange.endDate
    ) {
      return;
    }
    loadIndicators();
  }, [currentYear, currentMonth, loadIndicators]);

  useEffect(() => {
    if (selectedDate) {
      loadDayData(selectedDate);
      const baseDate = parseLocalDate(selectedDate);
      const previousDate = new Date(baseDate);
      previousDate.setDate(previousDate.getDate() - 1);
      const nextDate = new Date(baseDate);
      nextDate.setDate(nextDate.getDate() + 1);
      prefetchDayData(toDateString(previousDate));
      prefetchDayData(toDateString(nextDate));
    } else {
      setDayData(null);
      setStickyNote(null);
    }
  }, [selectedDate, loadDayData, prefetchDayData]);

  const goToPreviousMonth = useCallback(() => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(y => y - 1);
    } else {
      setCurrentMonth(m => m - 1);
    }
  }, [currentMonth]);

  const goToNextMonth = useCallback(() => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(y => y + 1);
    } else {
      setCurrentMonth(m => m + 1);
    }
  }, [currentMonth]);

  const goToToday = useCallback(() => {
    const today = new Date();
    setCurrentMonth(today.getMonth());
    setCurrentYear(today.getFullYear());
    setSelectedDate(getTodayString());
  }, []);

  const selectDate = useCallback((date: string | null) => {
    setSelectedDate(date);
  }, []);

  const setMonth = useCallback((month: number) => {
    setCurrentMonth(month);
  }, []);

  const setYear = useCallback((year: number) => {
    setCurrentYear(year);
  }, []);

  const createTodo = useCallback(async (content: string) => {
    if (!selectedDate) return null;
    const todo = await todosService.createTodo(selectedDate, content);
    if (todo) {
      setDayData(prev => {
        if (!prev) return prev;
        const next = { ...prev, todos: [...prev.todos, todo] };
        dayDataCacheRef.current.set(next.date, next);
        return next;
      });
      await loadIndicators();
    }
    return todo;
  }, [selectedDate, loadIndicators]);

  const updateTodo = useCallback(async (
    id: string,
    updates: { content?: string; completed?: boolean }
  ) => {
    setDayData(prev => {
      if (!prev) return prev;
      const next = {
        ...prev,
        todos: prev.todos.map(t => t.id === id ? { ...t, ...updates } : t)
      };
      dayDataCacheRef.current.set(next.date, next);
      return next;
    });

    const updated = await todosService.updateTodo(id, updates);
    if (selectedDate && updates.completed !== undefined) {
      await loadIndicators();
    }
    return updated;
  }, [selectedDate, loadIndicators]);

  const deleteTodo = useCallback(async (id: string) => {
    setDayData(prev => {
      if (!prev) return prev;
      const next = { ...prev, todos: prev.todos.filter(t => t.id !== id) };
      dayDataCacheRef.current.set(next.date, next);
      return next;
    });

    const success = await todosService.deleteTodo(id);
    if (success && selectedDate) {
      await loadIndicators();
    }
    return success;
  }, [selectedDate, loadIndicators]);

  const reorderTodos = useCallback(async (todoIds: string[], reorderedTodos: DayData['todos']) => {
    setDayData(prev => {
      if (!prev) return prev;
      const next = { ...prev, todos: reorderedTodos };
      dayDataCacheRef.current.set(next.date, next);
      return next;
    });
    await todosService.reorderTodos(todoIds);
  }, []);

  const updateStickyNote = useCallback(async (id: string, content: string) => {
    if (!selectedDate) return null;
    const trimmedContent = content.trim();

    if (!id && trimmedContent.length > 0) {
      const newNote = await stickyNotesService.createStickyNote(selectedDate, content);
      if (!newNote) {
        return null;
      }
      setStickyNote(newNote);
      setDayData(prev => {
        if (!prev) return prev;
        const next = { ...prev, stickyNotes: [newNote] };
        dayDataCacheRef.current.set(next.date, next);
        return next;
      });
      await loadIndicators();
      return newNote;
    }

    if (id && trimmedContent.length === 0) {
      await stickyNotesService.deleteStickyNote(id);
      setStickyNote({ id: '', date: selectedDate, content: '' });
      setDayData(prev => {
        if (!prev) return prev;
        const next = { ...prev, stickyNotes: [] };
        dayDataCacheRef.current.set(next.date, next);
        return next;
      });
      await loadIndicators();
      return null;
    }

    if (id) {
      const updated = await stickyNotesService.updateStickyNote(id, content);
      if (updated) {
        setStickyNote(updated);
        setDayData(prev => {
          if (!prev) return prev;
          const next = { ...prev, stickyNotes: [updated] };
          dayDataCacheRef.current.set(next.date, next);
          return next;
        });
        await loadIndicators();
      }
      return updated;
    }

    return null;
  }, [selectedDate, loadIndicators]);

  const refreshData = useCallback(async () => {
    await loadIndicators();
    if (selectedDate) {
      await loadDayData(selectedDate);
    }
  }, [loadIndicators, loadDayData, selectedDate]);

  useEffect(() => {
    const handler = () => {
      dayDataCacheRef.current.clear();
      refreshData();
    };
    window.addEventListener('import-complete', handler);
    return () => window.removeEventListener('import-complete', handler);
  }, [refreshData]);

  const visibleIndicators = useMemo(() => {
    if (!indicators) return null;
    const todosCounts = new Map(indicators.todosCounts);
    const range = indicatorsRangeRef.current;
    for (const todo of sharedTodos) {
      const date = todo.payload.date;
      if (range && (date < range.startDate || date > range.endDate)) continue;
      const count = todosCounts.get(date) ?? { total: 0, completed: 0 };
      todosCounts.set(date, { total: count.total + 1, completed: count.completed + Number(Boolean(todo.payload.completed)) });
    }
    return { ...indicators, todosCounts };
  }, [indicators, sharedTodos]);

  return {
    currentMonth,
    currentYear,
    selectedDate,
    indicators: visibleIndicators,
    dayData,
    stickyNote,
    isLoadingIndicators,
    isLoadingDayData,
    goToPreviousMonth,
    goToNextMonth,
    goToToday,
    selectDate,
    setMonth,
    setYear,
    createTodo,
    updateTodo,
    deleteTodo,
    reorderTodos,
    updateStickyNote,
    refreshData,
    loadIndicatorsForDateRange,
  };
}
