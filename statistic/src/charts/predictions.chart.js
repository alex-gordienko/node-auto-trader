import React from "react";
import { Box, Typography, Paper } from '@mui/material'
import {
  LineChart,
  lineElementClasses,
  markElementClasses
} from '@mui/x-charts/LineChart'
import {format} from 'date-fns'

import DigitalOceanService from "../services/DigitalOcean.storage.service";

const PredictionsChart = () => { 
  const [loading, setLoading] = React.useState(true);
  const [chartData, setChartData] = React.useState({currencyData: [], LSTMdata:[], CNNdata:[]})

  React.useEffect(() => {
    const getData = async () => {
      try {
        setLoading(true);
        const predictions = await DigitalOceanService.getTensorflowPredictionHistory();
        const currency = await DigitalOceanService.getTradingHistory('WAVES-ETH-minute');

        const today = new Date()
        const fourDaysAgo = new Date()
        fourDaysAgo.setDate(today.getDate() - 2)

        console.log(predictions)
        console.log(currency)

        const dataResponse = predictions.reduce((acc, item) => {
          const realCurrency = currency.find((currency) =>  Math.floor(item.timestamp / 1000) * 1000 === currency.time * 1000) || {
            time: item.timestamp,
            high: 0,
            low: 0,
            open: 0,
            volumefrom: 0,
            volumeto: 0,
            close: 0,
            conversionType: 'null',
            conversionSymbol: 'null'
          }

          if (!realCurrency.close) {
            return acc;
          }

          if (item.LSTMpredictedValue > 0.001) {
            return acc
          }

          return {
            currencyData: [...acc.currencyData, {timestamp: realCurrency.time * 1000, value: realCurrency.close}],
            LSTMdata: [...acc.LSTMdata, { timestamp: item.LSTMtimestamp, lstmvalue: item.LSTMpredictedValue }],
            CNNdata: [...acc.CNNdata, { timestamp: item.CNNtimestamp, cnnvalue: item.CNNpredictedValue }]
          }
        }, {currencyData: [], LSTMdata:[], CNNdata:[]});

        console.log(dataResponse)
        setChartData(dataResponse);
      } catch (error) {
        console.error(error);
      } finally { 
        setLoading(false);
      }
    }

    getData();
  }, [chartData.currencyData.length]);

  console.log([...chartData.currencyData, ...chartData.LSTMdata, ...chartData.CNNdata])

  return (
    <Paper sx={{ display: 'flex', flexDirection: 'column', height: '600px' }}>
      <Box>
        <Typography variant="h4">Predictions</Typography>
      </Box>  
      <Box sx={{display: 'grid', width: "100%", height: "600px" }}>
        <LineChart
          loading={loading}
          width={1600}
          height={600}
          grid={{ vertical: true, horizontal: true }}
          dataset={[...chartData.currencyData, ...chartData.LSTMdata, ...chartData.CNNdata]}
          xAxis={[{
            dataKey: 'timestamp',
            scaleType: 'time',
            valueFormatter: (date) => format(date, 'dd/MM HH:mm')
          }]}
          series={[
            {
              label: 'Currency',
              dataKey: 'value',
              id: 'realCurreny',
              showMark: false,
              valueFormatter: (value) => `${value?.toFixed(7)}`
            },
            {
              label: 'LSTM prediction',
              dataKey: 'lstmvalue',
              id: 'LSTM',
              showMark: false,
              valueFormatter: (value) => `${value?.toFixed(7)}`
            },
            {
              label: 'CNN prediction',
              dataKey: 'cnnvalue',
              id: 'CNN',
              showMark: false,
              valueFormatter: (value) => `${value?.toFixed(7)}`
            }
          ]}
          sx={{
            [`.${lineElementClasses.root}, .${markElementClasses.root}`]: {
              strokeWidth: 2,
            },
            '.MuiLineElement-series-LSTM': {
              strokeWidth: 3,
              strokeDasharray: '5 5',
            },
            '.MuiLineElement-series-CNN': {
              strokeWidth: 3,
              strokeDasharray: '3 4 5 2',
            },
            [`.${markElementClasses.root}:not(.${markElementClasses.highlighted})`]: {
              fill: '#fff',
            },
            [`& .${markElementClasses.highlighted}`]: {
              stroke: 'none',
            },
          }}
        />
      </Box>
    </Paper>
  )
}

export default PredictionsChart;