import { Box } from '@mui/material';
import PredictionsChart from './charts/predictions.chart';
import './App.css';

function App() {
  return (
    <div className="App">
      <Box>
        <PredictionsChart />
      </Box>
    </div>
  );
}

export default App;
