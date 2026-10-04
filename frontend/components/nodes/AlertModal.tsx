'use client';

import { createPortal } from 'react-dom';
import { t } from '@/lib/i18n';

interface Props {
  title: string;
  message: string;
  onClose: () => void;
}

export default function AlertModal({ title, message, onClose }: Props) {
  const content = (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100000,
        background: 'rgba(0,0,0,0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'inherit',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '90%',
          maxWidth: 400,
          background: '#1c1c1c',
          borderRadius: 24,
          padding: '24px 28px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          border: '1px solid rgba(255,255,255,0.08)',
          textAlign: 'center',
          animation: 'modalSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        <div style={{ 
          fontSize: 18, 
          fontWeight: 600, 
          color: '#fff', 
          marginBottom: 12,
          letterSpacing: '-0.01em'
        }}>
          {title}
        </div>
        
        <div style={{ 
          fontSize: 14, 
          color: 'rgba(255,255,255,0.5)', 
          lineHeight: 1.6,
          marginBottom: 28,
        }}>
          {message}
        </div>

        <button
          onClick={onClose}
          style={{
            width: '100%',
            padding: '12px 0',
            borderRadius: 14,
            background: '#fff',
            color: '#000',
            border: 'none',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'transform 0.2s, background 0.2s',
            outline: 'none',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#f0f0f0'; e.currentTarget.style.transform = 'scale(1.02)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.transform = 'scale(1)'; }}
        >
          
          {t('知道了')}
        </button>
      </div>

      <style>{`
        @keyframes modalSlideUp {
          from { opacity: 0; transform: translateY(20px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null;
}
