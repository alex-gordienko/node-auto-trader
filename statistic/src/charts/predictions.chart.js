import React from "react";
import { Box, Typography, Paper } from '@mui/material'
import {
  LineChart,
  lineElementClasses,
  markElementClasses
} from '@mui/x-charts/LineChart'
import {format, addMinutes, isEqual, startOfMinute} from 'date-fns'

import DigitalOceanService from "../services/DigitalOcean.storage.service";

const PredictionsChart = () => { 
  const [loading, setLoading] = React.useState(true);
  const [chartData, setChartData] = React.useState({currencyData: [], LSTMdata:[], CNNdata:[]})

  React.useEffect(() => {
    const getData = async () => {
      try {
        setLoading(true);
        const predictions = (await DigitalOceanService.getTensorflowPredictionHistory()).slice(-2000);
        const currency = (await DigitalOceanService.getTradingHistory('WAVES-ETH-minute')).slice(-3000);

        const today = new Date()
        const fourDaysAgo = new Date()
        fourDaysAgo.setDate(today.getDate() - 2)

        console.log(predictions)
        console.log(currency)

        const dataResponse = predictions.reduce((acc, item) => {
          const predictionTime = startOfMinute(new Date(item.timestamp))

          const timeForLSTM = item.LSTMtimestamp ?
            startOfMinute(new Date(item.LSTMtimestamp))
            : startOfMinute(addMinutes(new Date(item.timestamp), 15))
          
          const timeForCNN = item.CNNtimestamp ?
            startOfMinute(new Date(item.CNNtimestamp))
            : startOfMinute(addMinutes(new Date(item.timestamp), 15))

          const realCurrency = currency.find((currency) => isEqual(predictionTime, startOfMinute(new Date(currency.time * 1000))))

          if (predictionTime < fourDaysAgo) {
            return acc
          }

          if (!realCurrency?.close) {
            return {
              currencyData: acc.currencyData,
              LSTMdata: [...acc.LSTMdata, { timestamp: timeForLSTM, lstmvalue: item.LSTMpredictedValue }],
              CNNdata: [...acc.CNNdata, { timestamp: timeForCNN, cnnvalue: item.CNNpredictedValue }]
            }
          }

          return {
            currencyData: [...acc.currencyData, {timestamp: startOfMinute(new Date(realCurrency.time * 1000)), value: realCurrency.close}],
            LSTMdata: [...acc.LSTMdata, { timestamp: timeForLSTM, lstm: item.LSTMpredictedValue }],
            CNNdata: [...acc.CNNdata, { timestamp: timeForCNN, cnn: item.CNNpredictedValue }]
          }
        }, {currencyData: [], LSTMdata:[], CNNdata:[]});

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
    <Paper sx={{ display: 'flex', flexDirection: 'column', height: '800px' }}>
      <Box>
        <Typography variant="h4">Predictions</Typography>
      </Box>  
      <Box sx={{display: 'grid', width: "100%", height: "600px" }}>
        <LineChart
          loading={loading}
          width={1600}
          height={800}
          grid={{ vertical: true, horizontal: true }}
          dataset={[...chartData.currencyData, ...chartData.LSTMdata, ...chartData.CNNdata]}
          xAxis={[{
            dataKey: 'timestamp',
            zoom: true,
            scaleType: 'time',
            valueFormatter: (date) => format(date, 'dd/MM HH:mm')
          }]}
          yAxis={[{
            tickSize: 0.0000001,
            tickInterval: 0.0000001
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
              dataKey: 'lstm',
              id: 'LSTM',
              showMark: false,
              valueFormatter: (lstmvalue) => `${lstmvalue?.toFixed(7)}`
            },
            {
              label: 'CNN prediction',
              dataKey: 'cnn',
              id: 'CNN',
              showMark: false,
              valueFormatter: (cnnvalue) => `${cnnvalue?.toFixed(7)}`
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