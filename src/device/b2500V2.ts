import { ControlHandlerDefinition } from '../controlHandler';
import { B2500V2DeviceData, B2500V2SmartMeterStatus, CommandParams } from '../types';
import {
  CommandType,
  extractAdditionalDeviceInfo,
  processCommand,
  registerBaseCommands,
  registerBaseFields,
} from './b2500Base';
import { registerDeviceDefinition } from '../deviceDefinition';
import {
  binarySensorComponent,
  buttonComponent,
  numberComponent,
  selectComponent,
  sensorComponent,
  switchComponent,
  textComponent,
} from '../homeAssistantDiscovery';
import { transformBoolean, transformTimeString } from './helpers';

/**
 * Create a time period handler for a specific setting
 */
export const timePeriodSettingHandler = (
  periodNumber: number,
  setting: string,
): ControlHandlerDefinition<B2500V2DeviceData> => ({
  command: `time-period/${periodNumber}/${setting}`,
  handler: ({ device, updateDeviceState, message, publishCallback, deviceState }) => {
    // Convert to zero-based index for internal use
    const periodIndex = periodNumber - 1;

    // Update the device state
    updateDeviceState(state => {
      if (state.timePeriods == null || state.timePeriods.length < periodNumber) {
        console.error(`No time period ${periodNumber} found for ${device.deviceId}`);
        return;
      }
      const newTimePeriodSettings = [...state.timePeriods.map(p => ({ ...p }))];
      // Update the appropriate setting
      switch (setting) {
        case 'enabled':
          newTimePeriodSettings[periodIndex].enabled =
            message.toLowerCase() === 'true' || message === '1' || message === 'ON';
          break;
        case 'start-time':
          // Validate time format (HH:MM)
          if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(message)) {
            console.error('Invalid start time format (should be HH:MM):', message);
            return;
          }
          newTimePeriodSettings[periodIndex].startTime = message;
          break;
        case 'end-time':
          // Validate time format (HH:MM)
          if (!/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/.test(message)) {
            console.error('Invalid end time format (should be HH:MM):', message);
            return;
          }
          newTimePeriodSettings[periodIndex].endTime = message;
          break;
        case 'output-value':
          const outputValue = parseInt(message, 10);
          if (isNaN(outputValue) || outputValue < 80 || outputValue > 800) {
            console.error('Invalid output value (should be 80-800):', message);
            return;
          }
          newTimePeriodSettings[periodIndex].outputValue = outputValue;
          break;
        default:
          console.error('Unknown time period setting:', setting);
          return;
      }

      console.log(`Current period ${periodNumber} settings:`, newTimePeriodSettings[periodIndex]);

      // Build time period parameters for all periods
      const params = buildTimePeriodParams(newTimePeriodSettings);

      // Process the command and send it
      publishCallback(
        processCommand(CommandType.TIMED_DISCHARGE, params, deviceState.useFlashCommands),
      );

      // Update the device state with the new settings
      return { timePeriods: newTimePeriodSettings };
    });
  },
});

/**
 * Build time period parameters for all periods
 */
function buildTimePeriodParams(
  timePeriods: NonNullable<B2500V2DeviceData['timePeriods']>,
): CommandParams {
  // Initialize command parameters
  const params: CommandParams = { md: 0 };

  // Process all 5 time periods
  for (const periodIndex of [1, 2, 3, 4, 5] as const) {
    const idx = periodIndex - 1;
    if (idx >= timePeriods.length) {
      break;
    }
    const period = timePeriods[idx];

    // Use new settings if available, otherwise use stored settings
    const enabled = period.enabled;
    const startTime = period.startTime;
    const endTime = period.endTime;
    const outputValue = period.outputValue;

    // Set parameters dynamically using the period index
    params[`a${periodIndex}`] = enabled ? 1 : 0;
    params[`b${periodIndex}`] = startTime;
    params[`e${periodIndex}`] = endTime;
    params[`v${periodIndex}`] = outputValue;
  }

  return params;
}

registerDeviceDefinition<B2500V2DeviceData>(
  {
    deviceTypes: ['HMA', 'HMF', 'HMK'],
    defaultState: { useFlashCommands: false },
    refreshDataPayload: 'cd=1',
    getAdditionalDeviceInfo: extractAdditionalDeviceInfo,
  },
  (field, command) => {
    registerBaseFields(field);
    registerBaseCommands(command);

    // Charging and discharging settings
    field({
      key: 'lv',
      path: ['batteryOutputThreshold'],
      advertise: sensorComponent<number>({
        id: 'battery_output_threshold',
        name: 'Battery Output Threshold',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'cs',
      path: ['chargingMode'],
      transform: v => {
        switch (v) {
          case '0':
            return 'chargeDischargeSimultaneously';
          case '1':
            return 'chargeThenDischarge';
        }
      },
      advertise: selectComponent({
        id: 'charging_mode',
        name: 'Charging Mode',
        command: 'charging-mode',
        valueMappings: {
          chargeDischargeSimultaneously: 'Simultaneous Charging/Discharging',
          chargeThenDischarge: 'Fully Charge Then Discharge',
        },
      }),
    });
    command('charging-mode', {
      handler: ({ message, publishCallback, deviceState }) => {
        const validModes = ['chargeDischargeSimultaneously', 'chargeThenDischarge'];
        if (!validModes.includes(message)) {
          console.error('Invalid charging mode value:', message);
          return;
        }

        let mode: number;
        switch (message) {
          case 'chargeDischargeSimultaneously':
            mode = 0;
            break;
          case 'chargeThenDischarge':
            mode = 1;
            break;
          default:
            mode = 0;
        }

        publishCallback(
          processCommand(CommandType.CHARGING_MODE, { md: mode }, deviceState.useFlashCommands),
        );
      },
    });

    field({
      key: 'md',
      path: ['adaptiveMode'],
      transform: transformBoolean,
      advertise: switchComponent({
        id: 'adaptive_mode',
        name: 'Adaptive Mode',
        icon: 'mdi:auto-fix',
        command: 'adaptive-mode',
      }),
    });

    /**
     * Control handler for adaptive mode
     */
    command('adaptive-mode', {
      handler: ({ message, publishCallback, deviceState }) => {
        const newState = message.toLowerCase() === 'true' || message === '1' || message === 'ON';
        let mode = newState ? 1 : 0;

        publishCallback(
          processCommand(CommandType.DISCHARGE_MODE, { md: mode }, deviceState.useFlashCommands),
        );
      },
    });

    for (const i of [0, 1, 2, 3, 4] as const) {
      field({
        key: `d${i + 1}`,
        path: ['timePeriods', i, 'enabled'],
        transform: transformBoolean,
        advertise: switchComponent({
          id: `time_period_${i + 1}_enabled`,
          name: `Time Period ${i + 1} Enabled`,
          icon: 'mdi:clock-time-four-outline',
          command: `time-period/${i + 1}/enabled`,
        }),
      });
      field({
        key: `e${i + 1}`,
        path: ['timePeriods', i, 'startTime'],
        transform: transformTimeString,
        advertise: textComponent({
          id: `time_period_${i + 1}_start_time`,
          name: `Time Period ${i + 1} Start Time`,
          command: `time-period/${i + 1}/start-time`,
          pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$',
        }),
      });
      field({
        key: `f${i + 1}`,
        path: ['timePeriods', i, 'endTime'],
        transform: transformTimeString,
        advertise: textComponent({
          id: `time_period_${i + 1}_end_time`,
          name: `Time Period ${i + 1} End Time`,
          command: `time-period/${i + 1}/end-time`,
          pattern: '^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$',
        }),
      });
      field({
        key: `h${i + 1}`,
        path: ['timePeriods', i, 'outputValue'],
        advertise: numberComponent({
          id: `time_period_${i + 1}_output_value`,
          name: `Time Period ${i + 1} Output Value`,
          unit_of_measurement: 'W',
          command: `time-period/${i + 1}/output-value`,
          min: 80,
          max: 800,
        }),
      });

      const timerPeriodCommands = [
        timePeriodSettingHandler(i, 'enabled'),
        timePeriodSettingHandler(i, 'start-time'),
        timePeriodSettingHandler(i, 'end-time'),
        timePeriodSettingHandler(i, 'output-value'),
      ];
      for (const { command: name, ...commandHandler } of timerPeriodCommands) {
        command(name, commandHandler);
      }
    }

    // Daily power statistics
    field({
      key: 'bc',
      path: ['dailyStats', 'batteryChargingPower'],
      advertise: sensorComponent<number>({
        id: 'battery_charging_power',
        name: 'Battery Charging Power',
        device_class: 'energy',
        unit_of_measurement: 'Wh',
        state_class: 'total_increasing',
      }),
    });
    field({
      key: 'bs',
      path: ['dailyStats', 'batteryDischargePower'],
      advertise: sensorComponent<number>({
        id: 'battery_discharge_power',
        name: 'Battery Discharge Power',
        device_class: 'energy',
        unit_of_measurement: 'Wh',
        state_class: 'total_increasing',
      }),
    });
    field({
      key: 'pt',
      path: ['dailyStats', 'photovoltaicChargingPower'],
      advertise: sensorComponent<number>({
        id: 'photovoltaic_charging_power',
        name: 'Photovoltaic Charging Power',
        device_class: 'energy',
        unit_of_measurement: 'Wh',
        state_class: 'total_increasing',
      }),
    });
    field({
      key: 'it',
      path: ['dailyStats', 'microReverseOutputPower'],
      advertise: sensorComponent<number>({
        id: 'micro_reverse_output_power',
        name: 'Micro Reverse Output Power',
        device_class: 'energy',
        unit_of_measurement: 'Wh',
        state_class: 'total_increasing',
      }),
    });

    // CT information
    field({
      key: 'sg',
      path: ['ctInfo', 'connected'],
      transform: transformBoolean,
      advertise: binarySensorComponent({
        id: 'ct_connected',
        name: 'CT Connected',
        device_class: 'power',
      }),
    });
    field({
      key: 'sp',
      path: ['ctInfo', 'automaticPowerSize'],
      advertise: sensorComponent<number>({
        id: 'ct_automatic_power_size',
        name: 'CT Automatic Power Size',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'st',
      path: ['ctInfo', 'transmittedPower'],
      advertise: sensorComponent<number>({
        id: 'ct_transmitted_power',
        name: 'CT Transmitted Power',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'c0',
      path: ['ctInfo', 'connectedPhase'],
      transform: v => {
        // Phase connected to Smart Meter (0/1/2/255, 255=no channel)
        const num = Number(v);
        switch (num) {
          case 0:
          case 1:
          case 2:
            return num;
          case 3:
            return 'searching';
          case 255:
            return 'unknown';
        }
      },
      advertise: selectComponent<
        NonNullable<NonNullable<B2500V2DeviceData['ctInfo']>['connectedPhase']>
      >({
        id: 'ct_connected_phase',
        command: 'connected-phase',
        name: 'CT Connected Phase',
        valueMappings: {
          0: 'Phase 1',
          1: 'Phase 2',
          2: 'Phase 3',
          searching: 'Searching',
          unknown: 'None',
        },
      }),
    });
    command('connected-phase', {
      handler: ({ message, publishCallback, deviceState }) => {
        let channelValue = message;
        if (['auto', 'none', 'null', 'unknown'].includes(message.toLowerCase())) {
          channelValue = '255';
        }
        const channel = parseInt(channelValue, 10);
        if (isNaN(channel) || channel < 0 || (channel > 4 && channel !== 255)) {
          console.error('Invalid connected phase value:', message);
          return;
        }

        publishCallback(
          processCommand(
            CommandType.SET_CONNECTED_PHASE,
            { md: channel },
            deviceState.useFlashCommands,
          ),
        );
      },
    });

    field({
      key: 'c1',
      path: ['ctInfo', 'status'],
      transform: v => {
        const num = Number(v);
        switch (num) {
          case 5:
            return 'preparing1';
          case 6:
            return 'preparing2';
          case 7:
            return 'diagnosingEquipment';
          case 8:
            return 'diagnosingChannel';
          case 9:
            return 'diagnosisTimeout';
          case 10:
            return 'chargingInProgress';
          case 11:
            return 'unableToFindChannel';
          default:
            return 'notInDiagnosis';
        }
      },
      advertise: sensorComponent<B2500V2SmartMeterStatus>({
        id: 'ct_status',
        name: 'CT Status',
        valueMappings: {
          preparing1: 'Preparing to diagnose CT001 (Step 1)',
          preparing2: 'Preparing to diagnose CT001 (Step 2)',
          diagnosingEquipment: 'Diagnosing CT001 equipment',
          diagnosingChannel: 'Diagnosing CT001 channel',
          diagnosisTimeout: 'Diagnosis timeout',
          chargingInProgress: 'Charging in progress',
          unableToFindChannel: 'Unable to find channel',
          notInDiagnosis: 'Not in diagnosis',
        } satisfies Record<B2500V2SmartMeterStatus, string>,
      }),
    });
    field({
      key: 'm0',
      path: ['ctInfo', 'phase1'],
      advertise: sensorComponent<number>({
        id: 'ct_clip_power1',
        name: 'CT Clip Power 1',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'm1',
      path: ['ctInfo', 'phase2'],
      advertise: sensorComponent<number>({
        id: 'ct_clip_power2',
        name: 'CT Clip Power 2',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'm2',
      path: ['ctInfo', 'phase3'],
      advertise: sensorComponent<number>({
        id: 'ct_clip_power3',
        name: 'CT Clip Power 3',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'm3',
      path: ['ctInfo', 'microInverterPower'],
      advertise: sensorComponent<number>({
        id: 'micro_inverter_power',
        name: 'Micro Inverter Power',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });

    // Power ratings
    field({
      key: 'lmo',
      path: ['ratedPower', 'output'],
      advertise: sensorComponent<number>({
        id: 'rated_output_power',
        name: 'Rated Output Power',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'lmi',
      path: ['ratedPower', 'input'],
      advertise: sensorComponent<number>({
        id: 'rated_input_power',
        name: 'Rated Input Power',
        device_class: 'power',
        unit_of_measurement: 'W',
      }),
    });
    field({
      key: 'lmf',
      path: ['ratedPower', 'isLimited'],
      transform: transformBoolean,
      advertise: binarySensorComponent({ id: 'rated_power_limited', name: 'Rated Power Limited' }),
    });

    command('time-zone', {
      handler: ({ message, publishCallback, deviceState }) => {
        const timezone = parseInt(message, 10);
        if (isNaN(timezone)) {
          console.error('Invalid time zone value:', message);
          return;
        }

        publishCallback(
          processCommand(CommandType.TIME_ZONE, { wy: timezone }, deviceState.useFlashCommands),
        );
      },
    });
    command('sync-time', {
      handler: ({ message, publishCallback, deviceState }) => {
        try {
          // If the message is "PRESS" or similar from Home Assistant button, generate current time
          if (message === 'PRESS' || message === 'press' || message === 'true' || message === '1') {
            const now = new Date();
            const timeData = {
              wy: 480, // Default timezone offset
              yy: now.getFullYear() - 1900,
              mm: now.getMonth(),
              rr: now.getDate(),
              hh: now.getHours(),
              mn: now.getMinutes(),
              ss: now.getSeconds(),
            };
            publishCallback(
              processCommand(CommandType.SYNC_TIME, timeData, deviceState.useFlashCommands),
            );
            return;
          }

          // Otherwise try to parse as JSON
          const timeData = JSON.parse(message);
          if (
            !timeData.wy ||
            !timeData.yy ||
            !timeData.mm ||
            !timeData.rr ||
            !timeData.hh ||
            !timeData.mn ||
            !timeData.ss
          ) {
            console.error('Missing time parameters:', message);
            return;
          }

          publishCallback(
            processCommand(CommandType.SYNC_TIME, timeData, deviceState.useFlashCommands),
          );
        } catch (error) {
          console.error('Invalid time sync data:', message);
        }
      },
      advertise: buttonComponent({
        id: 'sync_time',
        name: 'Sync Time',
        icon: 'mdi:clock-sync',
        command: 'sync-time',
        payload_press: 'PRESS',
        enabled_by_default: false,
      }),
    });
  },
);
