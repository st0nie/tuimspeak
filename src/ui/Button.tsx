import { useRef, type ReactNode } from "react";
import { Box, Text, type DOMElement } from "ink";
import { useMouseRegion } from "../mouse/react.tsx";
import type { Layer } from "../mouse/bus.ts";

export interface ButtonProps {
  label: ReactNode;
  onClick?: () => void;
  /** Hold-to-press buttons (push to talk). */
  onPress?: () => void;
  onRelease?: () => void;
  onRightClick?: (e: { x: number; y: number }) => void;
  active?: boolean;
  focused?: boolean;
  color?: string;
  disabled?: boolean;
  layer?: Layer;
}

/** A clickable, keyboard-focusable `[ label ]`. */
export function Button({ label, onClick, onPress, onRelease, onRightClick, active, focused, color, disabled, layer }: ButtonProps) {
  const ref = useRef<DOMElement>(null);
  useMouseRegion(
    ref,
    {
      onClick: disabled ? undefined : onClick,
      onPress: disabled ? undefined : onPress,
      onRelease: disabled ? undefined : onRelease,
      onRightClick: disabled || !onRightClick ? undefined : (e) => onRightClick({ x: e.x, y: e.y }),
    },
    { layer },
  );
  const fg = disabled ? "gray" : focused ? "cyan" : color;
  return (
    <Box ref={ref} flexShrink={0}>
      <Text inverse={Boolean(active || focused)} bold={Boolean(focused)} color={fg} dimColor={disabled}>
        [{label}]
      </Text>
    </Box>
  );
}
