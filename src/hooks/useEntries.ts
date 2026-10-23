import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import type { JournalEntry, EntryUpdate } from '../types/entry';
import * as entriesService from '../services/entries';
import { useEntryNavigation } from '../contexts/EntryNavigationContext';
import { useEntriesState } from '../contexts/EntriesStateContext';

const PAGE_SIZE = 30;

interface UseEntriesReturn {
    entries: JournalEntry[];
    totalCount: number;
    selectedEntry: JournalEntry | null;
    selectedEntryId: string | null;
    isLoading: boolean;
    isResolvingTarget: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    selectEntry: (id: string | null) => void;
    createEntry: (date?: string) => Promise<JournalEntry>;
    updateEntry: (id: string, updates: EntryUpdate) => Promise<void>;
    deleteEntry: (id: string) => Promise<void>;
    loadMore: () => Promise<void>;
    refreshEntries: () => Promise<JournalEntry[]>;
}

export function useEntries(): UseEntriesReturn {
    const {
        state,
        setEntries,
        appendEntries,
        updateEntryInState,
        removeEntry,
        addEntry,
        setSelectedEntryId,
        setTotalCount,
        setHasMore,
        setCursor,
        setScrollOffset,
        setInitialized,
    } = useEntriesState();

    const { target, clearTarget } = useEntryNavigation();
    const handledTargetId = useRef<string | null>(null);
    const isLoadingRef = useRef(false);
    const loadVersionRef = useRef(0);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [isResolvingTarget, setIsResolvingTarget] = useState(false);

    const isLoading = !state.isInitialized;

    useEffect(() => {
        if (state.isInitialized || isLoadingRef.current) return;
        isLoadingRef.current = true;
        const version = ++loadVersionRef.current;

        const loadInitial = async () => {
            try {
                const [page, count] = await Promise.all([
                    entriesService.getEntriesPage(null, PAGE_SIZE),
                    entriesService.getEntriesCount(),
                ]);

                if (loadVersionRef.current !== version) return;

                setEntries(page.entries);
                setTotalCount(count);
                setHasMore(page.hasMore);
                setCursor(page.nextCursor);
            } catch (error) {
                if (loadVersionRef.current !== version) return;
                console.error('Failed to load initial entries:', error);
                setEntries([]);
                setTotalCount(0);
                setHasMore(false);
                setCursor(null);
            } finally {
                if (loadVersionRef.current === version) {
                    setInitialized(true);
                }
                isLoadingRef.current = false;
            }
        };

        void loadInitial();
    }, [state.isInitialized, setEntries, setTotalCount, setHasMore, setCursor, setInitialized]);

    useEffect(() => {
        if (!target) {
            setIsResolvingTarget(false);
            return;
        }

        const existingEntry = state.entries.find((entry) => entry.id === target.entryId);
        if (existingEntry) {
            setIsResolvingTarget(false);
            if (handledTargetId.current !== target.entryId || state.selectedEntryId !== target.entryId) {
                handledTargetId.current = target.entryId;
                setScrollOffset(0);
                setSelectedEntryId(target.entryId);
            }
            if (!target.sourceRange) {
                clearTarget();
            }
            return;
        }

        if (!state.isInitialized) {
            setIsResolvingTarget(true);
            return;
        }

        if (handledTargetId.current === target.entryId) {
            return;
        }

        handledTargetId.current = target.entryId;
        setScrollOffset(0);
        setIsResolvingTarget(true);
        let cancelled = false;

        entriesService.getEntriesByIds([target.entryId])
            .then((fetched) => {
                if (cancelled) return;

                if (fetched.length > 0) {
                    const newList = [fetched[0], ...state.entries];
                    newList.sort((a, b) => b.date.localeCompare(a.date));
                    setEntries(newList);
                    setSelectedEntryId(target.entryId);
                }

                if (!target.sourceRange) {
                    clearTarget();
                }
            })
            .catch((error) => {
                if (!cancelled) {
                    console.error('Failed to load target entry for navigation:', error);
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setIsResolvingTarget(false);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [
        clearTarget,
        state.entries,
        state.isInitialized,
        state.selectedEntryId,
        target,
        setSelectedEntryId,
        setEntries,
        setScrollOffset,
    ]);

    const selectedEntry = useMemo(
        () => {
            const selected = state.entries.find((entry) => entry.id === state.selectedEntryId) || null;
            if (selected) {
                return selected;
            }

            if (target) {
                return state.entries.find((entry) => entry.id === target.entryId) || null;
            }

            return null;
        },
        [state.entries, state.selectedEntryId, target]
    );

    const createEntry = useCallback(async (date?: string) => {
        const newEntry = await entriesService.createEntry(date);
        addEntry(newEntry);
        return newEntry;
    }, [addEntry]);

    const updateEntry = useCallback(async (id: string, updates: EntryUpdate) => {
        const updated = await entriesService.updateEntry(id, updates);
        if (updated) {
            updateEntryInState(id, () => updated);
            if (updates.date) {
                setEntries(
                    [...state.entries.map(e => e.id === id ? updated : e)]
                        .sort((a, b) => b.date.localeCompare(a.date))
                );
            }
        }
    }, [updateEntryInState, setEntries, state.entries]);

    const deleteEntry = useCallback(async (id: string) => {
        const success = await entriesService.deleteEntry(id);
        if (success) {
            removeEntry(id);
        }
    }, [removeEntry]);

    const selectEntry = useCallback((id: string | null) => {
        const newId = (id === state.selectedEntryId) ? null : id;
        setSelectedEntryId(newId);
    }, [state.selectedEntryId, setSelectedEntryId]);

    const loadMore = useCallback(async () => {
        if (isLoadingMore || !state.hasMore || !state.cursor) return;

        setIsLoadingMore(true);
        try {
            const page = await entriesService.getEntriesPage(state.cursor, PAGE_SIZE);
            appendEntries(page.entries);
            setHasMore(page.hasMore);
            setCursor(page.nextCursor);
        } catch (error) {
            console.error('Failed to load more entries:', error);
        } finally {
            setIsLoadingMore(false);
        }
    }, [isLoadingMore, state.hasMore, state.cursor, appendEntries, setHasMore, setCursor]);

    const refreshEntries = useCallback(async () => {
        const [page, count] = await Promise.all([
            entriesService.getEntriesPage(null, PAGE_SIZE),
            entriesService.getEntriesCount(),
        ]);

        setEntries(page.entries);
        setTotalCount(count);
        setHasMore(page.hasMore);
        setCursor(page.nextCursor);

        return page.entries;
    }, [setEntries, setTotalCount, setHasMore, setCursor]);

    useEffect(() => {
        const refresh = () => { void refreshEntries().catch(error => console.error('Could not refresh synced entries:', error)); };
        window.addEventListener('account:entries-changed', refresh);
        return () => window.removeEventListener('account:entries-changed', refresh);
    }, [refreshEntries]);

    return {
        entries: state.entries,
        totalCount: state.totalCount,
        selectedEntry,
        selectedEntryId: state.selectedEntryId,
        isLoading,
        isResolvingTarget,
        isLoadingMore,
        hasMore: state.hasMore,
        selectEntry,
        createEntry,
        updateEntry,
        deleteEntry,
        loadMore,
        refreshEntries,
    };
}
