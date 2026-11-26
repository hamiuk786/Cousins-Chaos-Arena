import React, { useState } from 'react';
import {
  Check,
  Edit3,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { MAX_PARTICIPANTS, RoomSnapshot } from '../../shared/protocol';

interface HostPanelProps {
  snapshot: RoomSnapshot | null;
  onAddCousin: (name: string) => void;
  onBulkAddCousins: (names: string[]) => void;
  onEditCousin: (playerId: string, name: string) => void;
  onRemoveCousin: (playerId: string) => void;
  onGenerateBalloons: () => void;
  onStartMatch: () => void;
  onPauseMatch: () => void;
  onResumeMatch: () => void;
  onEndMatch: () => void;
  onRestartMatch: () => void;
  onResetScores: () => void;
  onClose?: () => void;
}

const SAMPLE_30_COUSINS = [
  'Aarav', 'Diya', 'Rohan', 'Meera', 'Kabir', 'Ananya', 'Vivaan', 'Zara', 'Arjun', 'Priya',
  'Dev', 'Nisha', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rishi', 'Maya', 'Sameer', 'Kavya',
  'Vikram', 'Rhea', 'Siddharth', 'Pooja', 'Aditya', 'Neha', 'Pranav', 'Ishita', 'Varun', 'Shreya',
];

export const HostPanel: React.FC<HostPanelProps> = ({
  snapshot,
  onAddCousin,
  onBulkAddCousins,
  onEditCousin,
  onRemoveCousin,
  onGenerateBalloons,
  onStartMatch,
  onPauseMatch,
  onResumeMatch,
  onEndMatch,
  onRestartMatch,
  onResetScores,
  onClose,
}) => {
  const [singleName, setSingleName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [showBulk, setShowBulk] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [activeTab, setActiveTab] = useState<'roster' | 'connections'>('roster');

  const balloons = snapshot?.balloons ?? [];
  const connections = snapshot?.connections ?? [];
  const status = snapshot?.status ?? 'WAITING';
  const isPaused = snapshot?.isPaused ?? false;
  const isLive = status === 'PLAYING' || status === 'COUNTDOWN';
  const canEditRoster = !isLive;
  const remainingSlots = MAX_PARTICIPANTS - balloons.length;

  const handleSingleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = singleName.trim();
    if (!trimmed) return;
    onAddCousin(trimmed);
    setSingleName('');
  };

  const handleBulkSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const names = bulkText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0) return;
    onBulkAddCousins(names);
    setBulkText('');
    setShowBulk(false);
  };

  const handleSeed30 = () => {
    const existingNames = new Set(balloons.map((b) => b.name.toLowerCase()));
    const toAdd = SAMPLE_30_COUSINS.filter((n) => !existingNames.has(n.toLowerCase())).slice(
      0,
      remainingSlots,
    );
    if (toAdd.length > 0) {
      onBulkAddCousins(toAdd);
    }
  };

  const beginEdit = (playerId: string, currentName: string) => {
    setEditingId(playerId);
    setEditValue(currentName);
  };

  const commitEdit = () => {
    if (editingId && editValue.trim()) {
      onEditCousin(editingId, editValue.trim());
    }
    setEditingId(null);
    setEditValue('');
  };

  return (
    <aside className="bg-white border border-[#E5E1D8] rounded-xl p-5 flex flex-col gap-5 h-full">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#1C1917]">
            Host Controls
          </h2>
          <p className="text-xs text-[#6B655E] mt-0.5 tabular-nums">
            {balloons.length}/{MAX_PARTICIPANTS} cousins · {connections.length} connected
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Host Controls"
            className="p-2 text-[#57534E] hover:text-[#1C1917] rounded-lg hover:bg-[#F5F2EB] transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Match Lifecycle Controls */}
      <div className="space-y-2.5 pb-4 border-b border-[#EFECE6]">
        <div className="grid grid-cols-2 gap-2">
          {!isLive ? (
            <>
              <button
                type="button"
                onClick={onGenerateBalloons}
                disabled={balloons.length === 0}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg border border-[#D6D1C7] text-[#1C1917] hover:bg-[#F5F2EB] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Stage Balloons
              </button>
              <button
                type="button"
                onClick={onStartMatch}
                disabled={balloons.length < 2}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg bg-[#0F5132] text-white hover:bg-[#0B3D25] disabled:opacity-40 transition-colors whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                Start Match
              </button>
            </>
          ) : (
            <>
              {isPaused ? (
                <button
                  type="button"
                  onClick={onResumeMatch}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg bg-[#0F5132] text-white hover:bg-[#0B3D25] transition-colors whitespace-nowrap"
                >
                  <Play className="w-3.5 h-3.5" />
                  Resume Match
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onPauseMatch}
                  className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg bg-[#C59B27] text-white hover:bg-[#A6811E] transition-colors whitespace-nowrap"
                >
                  <Pause className="w-3.5 h-3.5" />
                  Pause Match
                </button>
              )}
              <button
                type="button"
                onClick={onEndMatch}
                className="flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold rounded-lg border border-[#DC2626]/30 text-[#B91C1C] hover:bg-[#FEF2F2] transition-colors whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" />
                End Match
              </button>
            </>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onRestartMatch}
            disabled={balloons.length < 2}
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#E5E1D8] text-[#44403C] hover:bg-[#F5F2EB] disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Restart Round
          </button>
          <button
            type="button"
            onClick={onResetScores}
            disabled={isLive || balloons.length === 0}
            className="flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-[#E5E1D8] text-[#44403C] hover:bg-[#F5F2EB] disabled:opacity-40 transition-colors whitespace-nowrap"
          >
            Reset Scores
          </button>
        </div>
      </div>

      {/* Segmented Switch: Roster vs Connected Devices */}
      <div className="flex items-center gap-1 p-1 bg-[#F5F2EB] rounded-lg">
        <button
          type="button"
          onClick={() => setActiveTab('roster')}
          className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'roster'
              ? 'bg-white text-[#1C1917] shadow-xs'
              : 'text-[#6B655E] hover:text-[#1C1917]'
          }`}
        >
          Cousin Roster ({balloons.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('connections')}
          className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'connections'
              ? 'bg-white text-[#1C1917] shadow-xs'
              : 'text-[#6B655E] hover:text-[#1C1917]'
          }`}
        >
          Connections ({connections.length})
        </button>
      </div>

      {activeTab === 'roster' ? (
        <div className="flex-1 flex flex-col gap-3 min-h-0">
          {canEditRoster && (
            <div className="space-y-2.5">
              <form onSubmit={handleSingleAdd} className="flex gap-2">
                <input
                  type="text"
                  value={singleName}
                  onChange={(e) => setSingleName(e.target.value)}
                  maxLength={32}
                  placeholder="Add cousin name..."
                  className="flex-1 min-w-0 px-3 py-2 text-sm bg-[#FAF8F4] border border-[#E5E1D8] rounded-lg focus:outline-none focus:border-[#0F5132]"
                />
                <button
                  type="submit"
                  disabled={!singleName.trim() || remainingSlots <= 0}
                  className="px-3 py-2 text-xs font-semibold bg-[#0F5132] text-white rounded-lg hover:bg-[#0B3D25] disabled:opacity-40 transition-colors whitespace-nowrap flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add
                </button>
              </form>

              <div className="flex items-center justify-between gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => setShowBulk((v) => !v)}
                  className="font-medium text-[#0F5132] hover:underline whitespace-nowrap"
                >
                  {showBulk ? 'Hide bulk paste' : 'Paste multiple names'}
                </button>
                <button
                  type="button"
                  onClick={handleSeed30}
                  disabled={remainingSlots <= 0}
                  className="font-medium text-[#57534E] hover:text-[#1C1917] disabled:opacity-40 whitespace-nowrap"
                >
                  + Add 30 Sample Cousins
                </button>
              </div>

              {showBulk && (
                <form onSubmit={handleBulkSubmit} className="space-y-2">
                  <textarea
                    rows={3}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder="Paste cousin names separated by commas or new lines..."
                    className="w-full px-3 py-2 text-xs bg-[#FAF8F4] border border-[#E5E1D8] rounded-lg focus:outline-none focus:border-[#0F5132]"
                  />
                  <button
                    type="submit"
                    className="w-full py-2 text-xs font-semibold bg-[#1C1917] text-white rounded-lg hover:bg-[#292524] transition-colors"
                  >
                    Add All Names
                  </button>
                </form>
              )}
            </div>
          )}

          {/* Roster List */}
          <div className="flex-1 overflow-y-auto divide-y divide-[#F0EDE6] pr-1 max-h-[340px]">
            {balloons.length === 0 ? (
              <p className="text-xs text-[#78716C] py-6 text-center">
                No cousins added yet. Add names above or load 30 sample cousins to stage the arena.
              </p>
            ) : (
              balloons.map((b) => (
                <div key={b.playerId} className="py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 border border-black/10"
                      style={{ backgroundColor: b.color }}
                    />
                    {editingId === b.playerId ? (
                      <div className="flex items-center gap-1 flex-1 min-w-0">
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit();
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          maxLength={32}
                          autoFocus
                          className="flex-1 min-w-0 px-2 py-1 text-xs border border-[#0F5132] rounded bg-white"
                        />
                        <button
                          type="button"
                          onClick={commitEdit}
                          className="p-1 text-[#0F5132] hover:bg-[#F0FDF4] rounded"
                          aria-label="Save name"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-[#1C1917] truncate">{b.name}</p>
                        <p className="text-[11px] text-[#78716C] truncate">
                          {b.ownerUid
                            ? `${b.connected ? 'Online' : 'Offline'}${b.ready ? ' · Ready' : ''}`
                            : 'Unclaimed'}
                          {' · '}
                          <span className="font-mono tabular-nums">{b.score} pts</span>
                        </p>
                      </div>
                    )}
                  </div>

                  {canEditRoster && editingId !== b.playerId && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => beginEdit(b.playerId, b.name)}
                        aria-label={`Edit ${b.name}`}
                        className="p-1.5 text-[#78716C] hover:text-[#1C1917] rounded hover:bg-[#F5F2EB]"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveCousin(b.playerId)}
                        aria-label={`Remove ${b.name}`}
                        className="p-1.5 text-[#78716C] hover:text-[#DC2626] rounded hover:bg-[#FEF2F2]"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-[#F0EDE6] max-h-[380px]">
          {connections.length === 0 ? (
            <div className="py-8 text-center text-xs text-[#78716C] space-y-1">
              <Users className="w-5 h-5 mx-auto text-[#A8A29E]" />
              <p>No participants connected yet.</p>
            </div>
          ) : (
            connections.map((c) => (
              <div key={c.uid} className="py-2.5 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[#1C1917] truncate">
                    {c.displayName}
                    {c.isHost ? ' (Host)' : ''}
                  </p>
                  <p className="text-xs text-[#78716C] truncate">
                    {c.claimedName ? `Playing as ${c.claimedName}` : 'Spectating'}
                  </p>
                </div>
                <span className="text-xs font-medium text-[#0F5132] shrink-0">Connected</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Checkpoint & Single-Instance Status Footer */}
      <div className="pt-3 border-t border-[#EFECE6] text-[11px] text-[#78716C] flex items-center justify-between gap-2">
        <span>Single-Room Authoritative Server (30 Hz)</span>
        <span className="font-mono tabular-nums">
          {snapshot?.lastCheckpointAt
            ? `Saved ${new Date(snapshot.lastCheckpointAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
            : 'Ready'}
        </span>
      </div>
    </aside>
  );
};
