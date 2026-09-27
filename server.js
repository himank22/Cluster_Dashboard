const express = require('express');
const cors = require('cors');
const path = require('path');
const k8s = require('@kubernetes/client-node');

const app = express();
app.use(cors());
app.use(express.json());

// Frontend (index.html) को serve करने के लिए
app.use(express.static(path.join(__dirname, 'public')));

// Kubernetes Configuration Load करना:
// EKS Pod के अंदर यह ऑटोमैटिक In-Cluster ServiceAccount का इस्तेमाल करेगा,
// और local machine पर ~/.kube/config का इस्तेमाल करेगा।
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const appsApi = kc.makeApiClient(k8s.AppsV1Api);

// 1. Cluster Nodes Read करना
app.get('/api/nodes', async (req, res) => {
    try {
        const response = await k8sApi.listNode();
        const nodes = response.body.items.map(node => {
            const readyCondition = node.status?.conditions?.find(c => c.type === 'Ready');
            return {
                name: node.metadata.name,
                status: readyCondition && readyCondition.status === 'True' ? 'Ready' : 'NotReady',
                roles: Object.keys(node.metadata.labels || {})
                    .filter(l => l.includes('node-role'))
                    .map(l => l.split('/')[1] || 'worker'),
                kubeletVersion: node.status?.nodeInfo?.kubeletVersion || 'v1.28+',
                instanceType: node.metadata.labels?.['node.kubernetes.io/instance-type'] || 'aws-ec2',
                region: node.metadata.labels?.['topology.kubernetes.io/region'] || 'aws',
                cpu: node.status?.capacity?.cpu || 'N/A',
                memory: node.status?.capacity?.memory || 'N/A'
            };
        });
        res.json({ success: true, nodes });
    } catch (err) {
        console.error('Error fetching nodes:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Pods Read करना
app.get('/api/pods', async (req, res) => {
    const namespace = req.query.namespace || 'default';
    try {
        const response = namespace === 'all' 
            ? await k8sApi.listPodForAllNamespaces() 
            : await k8sApi.listNamespacedPod(namespace);

        const pods = response.body.items.map(p => ({
            name: p.metadata.name,
            namespace: p.metadata.namespace,
            node: p.spec.nodeName || 'Unassigned',
            status: p.status.phase,
            podIP: p.status.podIP || 'Pending',
            restarts: p.status.containerStatuses ? p.status.containerStatuses[0]?.restartCount || 0 : 0,
            containers: (p.spec.containers || []).map(c => ({
                name: c.name,
                image: c.image
            }))
        }));
        res.json({ success: true, pods });
    } catch (err) {
        console.error('Error fetching pods:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Deployment Scaling (Point & Click)
app.post('/api/scale', async (req, res) => {
    const { name, namespace = 'default', replicas } = req.body;
    try {
        const patch = [{
            op: 'replace',
            path: '/spec/replicas',
            value: parseInt(replicas, 10)
        }];
        const options = { headers: { 'Content-Type': 'application/json-patch+json' } };
        await appsApi.patchNamespacedDeploymentScale(
            name, namespace, patch, undefined, undefined, undefined, undefined, undefined, options
        );
        res.json({ success: true, message: `Successfully scaled ${name} to ${replicas}` });
    } catch (err) {
        console.error('Error scaling deployment:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Pod Logs Read करना
app.get('/api/pods/:name/logs', async (req, res) => {
    const { name } = req.params;
    const namespace = req.query.namespace || 'default';
    try {
        const logs = await k8sApi.readNamespacedPodLog(name, namespace, undefined, undefined, undefined, undefined, 200); // last 200 lines
        res.json({ success: true, logs: logs.body });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 5. Pod Delete / Evict करना
app.delete('/api/pods/:name', async (req, res) => {
    const { name } = req.params;
    const namespace = req.query.namespace || 'default';
    try {
        await k8sApi.deleteNamespacedPod(name, namespace);
        res.json({ success: true, message: `Pod ${name} evicted successfully` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Fallback to UI
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 EKS Visual Portal running on port ${PORT}`);
});