import { HStack, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  containerBackground,
  font,
  foregroundStyle,
  lineLimit,
  minimumScaleFactor,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { createWidget, type WidgetEnvironment } from 'expo-widgets';

export type FinanceWidgetProps = {
  netWorth: string;
  change: string;
  changeUp: boolean;
  billPayee: string;
  billAmount: string;
  billDue: string;
};

// NOTE: the body runs in an isolated widget runtime — it can only use
// @expo/ui/swift-ui components and may not reference anything declared at module
// scope. Keep every constant/helper inside the function or pass it via props.
const FinanceWidget = (props: FinanceWidgetProps, env: WidgetEnvironment) => {
  'widget';
  const bg = '#0a0a0f';
  const text = '#f0f0f5';
  const muted = '#6b6b80';
  const green = '#22c55e';
  const red = '#ef4444';
  const accent = '#a898ff';
  const medium = env.widgetFamily === 'systemMedium';
  const changeColor = props.changeUp ? green : red;

  return (
    <VStack
      alignment="leading"
      spacing={medium ? 5 : 3}
      modifiers={[padding({ all: 16 }), containerBackground(bg, 'widget')]}
    >
      <HStack spacing={0}>
        <Text modifiers={[font({ size: 11, weight: 'bold' }), foregroundStyle(muted)]}>NET WORTH</Text>
        <Spacer />
      </HStack>
      <Text
        modifiers={[
          font({ size: medium ? 34 : 27, weight: 'heavy' }),
          foregroundStyle(text),
          lineLimit(1),
          minimumScaleFactor(0.5),
        ]}
      >
        {props.netWorth}
      </Text>
      {props.change ? (
        <Text modifiers={[font({ size: 12, weight: 'semibold' }), foregroundStyle(changeColor)]}>
          {props.change}
        </Text>
      ) : null}

      <Spacer />

      <HStack spacing={0}>
        <Text modifiers={[font({ size: 10, weight: 'bold' }), foregroundStyle(muted)]}>NEXT BILL</Text>
        <Spacer />
      </HStack>
      {medium ? (
        <HStack spacing={8}>
          <VStack alignment="leading" spacing={1}>
            <Text modifiers={[font({ size: 14, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
              {props.billPayee}
            </Text>
            <Text modifiers={[font({ size: 11 }), foregroundStyle(muted)]}>{props.billDue}</Text>
          </VStack>
          <Spacer />
          {props.billAmount ? (
            <Text modifiers={[font({ size: 16, weight: 'bold' }), foregroundStyle(accent)]}>
              {props.billAmount}
            </Text>
          ) : null}
        </HStack>
      ) : (
        <VStack alignment="leading" spacing={1}>
          <Text modifiers={[font({ size: 13, weight: 'semibold' }), foregroundStyle(text), lineLimit(1)]}>
            {props.billPayee}
          </Text>
          <Text modifiers={[font({ size: 11 }), foregroundStyle(muted)]}>
            {props.billAmount ? props.billAmount + ' \u00b7 ' + props.billDue : props.billDue}
          </Text>
        </VStack>
      )}
    </VStack>
  );
};

const Widget = createWidget<FinanceWidgetProps>('FinanceWidget', FinanceWidget);

export function updateFinanceWidget(props: FinanceWidgetProps): void {
  Widget.updateSnapshot(props);
}

export default Widget;
