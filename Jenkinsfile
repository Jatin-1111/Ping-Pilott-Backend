pipeline {
    agent any
    
    stages {
        stage('Checkout') {
            steps {
                git branch: 'main', url: 'https://github.com/Jatin-1111/Ping-Pilott-Backend.git', credentialsId: 'github-credentials'
            }
        }
        
        stage('Install Dependencies') {
            steps {
                bat 'npm install'
            }
        }
        
        stage('Build Docker Image') {
            steps {
                bat 'docker build -t ping-pilot:%BUILD_NUMBER% .'
            }
        }
        
        stage('Build & Push to Docker Hub') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'dockerhub-creds', usernameVariable: 'DH_USER', passwordVariable: 'DH_PASS')]) {
                    bat '''
                    docker login -u %DH_USER% -p %DH_PASS%
                    docker tag ping-pilot:%BUILD_NUMBER% %DH_USER%/ping-pilot:%BUILD_NUMBER%
                    docker tag ping-pilot:%BUILD_NUMBER% %DH_USER%/ping-pilot:latest
                    docker push %DH_USER%/ping-pilot:%BUILD_NUMBER%
                    docker push %DH_USER%/ping-pilot:latest
                    '''
                }
            }
        }
    }
    
    post {
        success {
            echo '✅ Build & Push Successful!'
        }
        failure {
            echo '❌ Build Failed!'
        }
    }
}