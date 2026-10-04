import React from 'react';
import { useViewport } from '@xyflow/react';
import { useHelperLinesStore } from '@/hooks/useAutoAlign';

type HelperLinesProps = {
  horizontal?: number;
  vertical?: number;
};

const HelperLines: React.FC<HelperLinesProps> = (props) => {
  const lines = useHelperLinesStore((st) => st.lines);
  const horizontal = props.horizontal ?? lines.horizontal;
  const vertical = props.vertical ?? lines.vertical;
  const { x, y, zoom } = useViewport();

  if (horizontal === undefined && vertical === undefined) return null;

  // Transform flow coordinates to screen coordinates relative to the ReactFlow container
  const screenVertical = vertical !== undefined ? vertical * zoom + x : undefined;
  const screenHorizontal = horizontal !== undefined ? horizontal * zoom + y : undefined;

  return (
    <svg
      style={{
        position: 'absolute',
        width: '100%',
        height: '100%',
        top: 0,
        left: 0,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      {screenVertical !== undefined && (
        <line
          x1={screenVertical}
          y1="0"
          x2={screenVertical}
          y2="100%"
          stroke="rgba(255, 255, 255, 0.85)"
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.9"
        />
      )}
      {screenHorizontal !== undefined && (
        <line
          x1="0"
          y1={screenHorizontal}
          x2="100%"
          y2={screenHorizontal}
          stroke="rgba(255, 255, 255, 0.85)"
          strokeWidth="1"
          strokeDasharray="4 3"
          opacity="0.9"
        />
      )}
    </svg>
  );
};

export default HelperLines;
