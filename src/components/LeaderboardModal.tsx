import React from 'react';
import { Crown, RotateCcw, Trophy, X } from 'lucide-react';
import { LeaderboardEntry } from '../../shared/protocol';
import { StoredMatchRecord } from '../lib/firebase';

interface LeaderboardModalProps {
  roundNumber: number;
  leaderboard: LeaderboardEntry[];
  history: StoredMatchRecord[];
  isHost: boolean;
  onRestartMatch: () => void;
  onClose: () => void;
}

export const LeaderboardModal: React.FC<LeaderboardModalProps> = ({
  roundNumber,
  leaderboard,
  history,
  isHost,
  onRestartMatch,
  onClose,
}) => {
  const [tab, setTab] = React.useState<'current' | 'history'>('current');
  const winner = leaderboard[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1917]/55 backdrop-blur-[2px] p-4">
      <div className="bg-white border border-[#E5E1D8] rounded-2xl max-w-2xl w-full max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#EFECE6] flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium text-[#6B655E]">
              Round {roundNumber} Complete · Final Standings
            </p>
            <h2 className="font-display text-2xl font-bold text-[#1C1917] mt-0.5">
              {winner ? `${winner.name} Wins!` : 'Final Leaderboard'}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close leaderboard"
            className="p-2 text-[#57534E] hover:text-[#1C1917] rounded-lg hover:bg-[#F5F2EB] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Winner Spotlight */}
        {winner && tab === 'current' && (
          <div className="px-6 py-5 bg-[#FAF8F4] border-b border-[#EFECE6] flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold shadow-xs"
                style={{ backgroundColor: winner.color }}
              >
                <Crown className="w-6 h-6" />
              </div>
              <div>
                <p className="text-xs font-medium text-[#A16207]">Wedding Arena Champion</p>
                <p className="font-display text-xl font-bold text-[#1C1917]">{winner.name}</p>
                <p className="text-xs text-[#6B655E] mt-0.5 tabular-nums">
                  {winner.pops} pops · {winner.hits} hits
                  {winner.lastSurvivorBonus ? ' · Last Survivor +30' : ''}
                </p>
              </div>
            </div>
            <div className="text-right">
              <p className="font-mono text-3xl font-bold text-[#0F5132] tabular-nums">
                {winner.score}
              </p>
              <p className="text-xs text-[#6B655E]">total points</p>
            </div>
          </div>
        )}

        {/* Segmented Tab */}
        <div className="px-6 pt-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-[#F5F2EB] rounded-lg">
            <button
              type="button"
              onClick={() => setTab('current')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'current'
                  ? 'bg-white text-[#1C1917] shadow-xs'
                  : 'text-[#6B655E] hover:text-[#1C1917]'
              }`}
            >
              Round {roundNumber} Results
            </button>
            <button
              type="button"
              onClick={() => setTab('history')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                tab === 'history'
                  ? 'bg-white text-[#1C1917] shadow-xs'
                  : 'text-[#6B655E] hover:text-[#1C1917]'
              }`}
            >
              Saved Matches ({history.length})
            </button>
          </div>
          <p className="text-xs text-[#78716C] hidden sm:block">
            Hit +5 · Pop +20 · Last Survivor +30
          </p>
        </div>

        {/* Table Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {tab === 'current' ? (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#EFECE6] text-xs font-semibold text-[#78716C]">
                  <th className="py-2 pr-3 w-12">Rank</th>
                  <th className="py-2 pr-3">Cousin</th>
                  <th className="py-2 px-3 text-right">Hits</th>
                  <th className="py-2 px-3 text-right">Pops</th>
                  <th className="py-2 pl-3 text-right">Score</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F5F2EB] text-sm">
                {leaderboard.map((row) => (
                  <tr key={row.playerId} className="hover:bg-[#FAF8F4]/70">
                    <td className="py-2.5 pr-3 font-mono text-xs text-[#6B655E] tabular-nums">
                      #{row.rank}
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="w-3 h-3 rounded-full shrink-0"
                          style={{ backgroundColor: row.color }}
                        />
                        <span className="font-medium text-[#1C1917]">{row.name}</span>
                        {row.lastSurvivorBonus && (
                          <span className="text-xs font-medium text-[#A16207]">· Survivor +30</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs text-[#57534E] tabular-nums">
                      {row.hits}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-xs text-[#57534E] tabular-nums">
                      {row.pops}
                    </td>
                    <td className="py-2.5 pl-3 text-right font-mono font-semibold text-[#1C1917] tabular-nums">
                      {row.score}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-sm text-[#78716C]">
              <Trophy className="w-6 h-6 mx-auto mb-2 text-[#A8A29E]" />
              Completed rounds saved to Firestore will appear here.
            </div>
          ) : (
            <div className="divide-y divide-[#F0EDE6]">
              {history.map((m) => (
                <div key={m.matchId} className="py-3 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-[#1C1917]">
                      Round {m.roundNumber} · Winner: {m.winnerName}
                    </p>
                    <p className="text-xs text-[#78716C] mt-0.5 tabular-nums">
                      {m.participantCount} cousins · {m.durationSeconds}s ·{' '}
                      {new Date(m.finishedAtMs).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                  <span className="font-mono text-base font-bold text-[#0F5132] tabular-nums">
                    {m.winnerScore} pts
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-[#EFECE6] bg-[#FAF8F4] flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-[#57534E] hover:text-[#1C1917] transition-colors whitespace-nowrap"
          >
            Back to Arena
          </button>
          {isHost && (
            <button
              type="button"
              onClick={() => {
                onClose();
                onRestartMatch();
              }}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-[#0F5132] text-white rounded-lg hover:bg-[#0B3D25] transition-colors whitespace-nowrap"
            >
              <RotateCcw className="w-4 h-4" />
              Play Next Round
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
