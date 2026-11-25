/**
 * Функции-директивы, доступные LLM через processor (передаются в prepare).
 * Имена обязаны совпадать с типами Directive, которые vc-api умеет
 * конвертировать в команды колонки (см. buildDeviceDirectives в vc-api.ts).
 */
export interface DirectiveFunctionInfo {
  arguments: unknown
  description: string
}

export type DirectiveFunctions = Record<string, DirectiveFunctionInfo>

export const MARUSYA_DIRECTIVE_FUNCTIONS: DirectiveFunctions = {
  bluetoothDisable: {
    arguments: {
      additionalProperties: false,
      properties: {},
      type: 'object'
    },
    description: 'Выключить Bluetooth-сопряжение колонки'
  },
  bluetoothEnable: {
    arguments: {
      additionalProperties: false,
      properties: {},
      type: 'object'
    },
    description: 'Включить режим Bluetooth-сопряжения колонки (найти с телефона)'
  },
  soundLouder: {
    arguments: {
      additionalProperties: false,
      properties: {},
      type: 'object'
    },
    description: 'Сделать колонку громче на один шаг (примерно 10%)'
  },
  soundQuieter: {
    arguments: {
      additionalProperties: false,
      properties: {},
      type: 'object'
    },
    description: 'Сделать колонку тише на один шаг (примерно 10%)'
  },
  soundSetLevel: {
    arguments: {
      additionalProperties: false,
      properties: {
        level: {
          description: 'Желаемый уровень громкости от 0 до 10',
          maximum: 10,
          minimum: 0,
          type: 'integer'
        }
      },
      required: ['level'],
      type: 'object'
    },
    description: 'Установить громкость колонки (0-10)'
  }
}
