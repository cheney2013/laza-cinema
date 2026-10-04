'use client';

import React, { useState, useEffect } from 'react';
import { t, useT } from '@/lib/i18n';
import { useStore } from '@/lib/store';
import { api } from '@/lib/api';
import { showAlert, showPrompt } from '@/components/ui/Dialog';
import ProjectStudioModal from './ProjectStudioModal';
import CreateProjectModal from './CreateProjectModal';

export default function ProjectSwitcher() {
  const t = useT();
  const currentProjectId = useStore((s) => s.currentProjectId);
  const currentProjectName = useStore((s) => s.currentProjectName);
  const setCurrentProject = useStore((s) => s.setCurrentProject);

  const [studioModalOpen, setStudioModalOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);

  const handleRenameProject = async () => {
    if (!currentProjectId || isRenaming) return;

    const input = await showPrompt(t('请输入新的项目名称'), {
      title: '重命名项目',
      defaultValue: currentProjectName,
      confirmText: '保存',
    });
    if (input === null) return;

    const name = input.trim();
    if (!name) {
      await showAlert(t('项目名称不能为空'), { title: t('无法重命名'), danger: true });
      return;
    }
    if (name === currentProjectName) return;

    setIsRenaming(true);
    try {
      const project = await api.renameProject(currentProjectId, name);
      setCurrentProject(project.id, project.name);
    } catch (error: any) {
      await showAlert(t('重命名失败：{v1}', { v1: error?.message || error }), {
        title: '操作失败',
        danger: true,
      });
    } finally {
      setIsRenaming(false);
    }
  };

  // Keyboard shortcut Ctrl+P / Cmd+P & Global custom events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setStudioModalOpen(true);
      }
    };

    const handleOpenStudio = () => {
      setStudioModalOpen(true);
    };

    const handleOpenWizard = () => {
      setCreateModalOpen(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('openProjectStudio', handleOpenStudio);
    window.addEventListener('openProjectWizard', handleOpenWizard);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('openProjectStudio', handleOpenStudio);
      window.removeEventListener('openProjectWizard', handleOpenWizard);
    };
  }, []);

  return (
    <>
      <div className="relative inline-flex items-center">
        {/* ── Trigger Button (Click to open Project Studio Modal) ── */}
        <button
          type="button"
          onClick={() => setStudioModalOpen(true)}
          title={t('打开项目工作区中心 (Ctrl+P / ⌘P)')}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 hover:border-white/30 text-zinc-200 hover:text-white transition-all cursor-pointer select-none group active:scale-95"
        >
          {/* Project folder icon */}
          <div className="w-3.5 h-3.5 flex items-center justify-center text-zinc-300 group-hover:text-white">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>

          <span className="max-w-[120px] sm:max-w-[180px] truncate font-semibold tracking-tight text-[12px]">
            {currentProjectName || t('未命名工程')}
          </span>

          {/* Subtitle / Switch hint */}
          <span className="hidden xl:inline text-[9px] px-1 py-0.2 rounded bg-white/10 text-zinc-400 font-mono">
            
            {t('切换')}
          </span>
        </button>

        <button
          type="button"
          onClick={handleRenameProject}
          disabled={!currentProjectId || isRenaming}
          title={t('重命名当前项目')}
          aria-label={t('重命名当前项目')}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-zinc-400 transition-all hover:border-violet-400/40 hover:bg-violet-500/10 hover:text-violet-300 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isRenaming ? (
            <span className="h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          )}
        </button>
      </div>

      {/* ── Project Studio Modal (项目库管理弹框) ─────────────── */}
      <ProjectStudioModal
        isOpen={studioModalOpen}
        onClose={() => setStudioModalOpen(false)}
        onOpenCreate={() => {
          setStudioModalOpen(false);
          setCreateModalOpen(true);
        }}
      />

      {/* ── Dedicated Create Project Modal (新建项目独立弹框) ──── */}
      <CreateProjectModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
      />
    </>
  );
}
